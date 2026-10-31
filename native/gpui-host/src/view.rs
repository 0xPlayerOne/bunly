use crate::{
    channel::EventSink,
    evidence::Evidence,
    input::{InputBinding, TextInput},
    state::SharedWindowState,
    style,
};
use bun_native_protocol::{Element as NativeElement, Event, NodeId, Tree, WindowId};
use gpui::{
    AnyElement, App, Context, Entity, FocusHandle, Focusable, KeyBinding, MouseButton, Window,
    actions, canvas, div, prelude::*, px, rgb,
};
use std::collections::BTreeMap;
use std::rc::Rc;

actions!(native_button, [ActivateButton]);

pub(crate) fn bind_keys(cx: &mut App) {
    cx.bind_keys([
        KeyBinding::new("enter", ActivateButton, Some("NativeButton")),
        KeyBinding::new("space", ActivateButton, Some("NativeButton")),
    ]);
}

pub(crate) struct NativeView {
    window_id: WindowId,
    state: SharedWindowState,
    inputs: BTreeMap<NodeId, Entity<TextInput>>,
    buttons: BTreeMap<NodeId, FocusHandle>,
    events: EventSink,
    evidence: Evidence,
}

impl NativeView {
    pub(crate) fn new(
        window_id: WindowId,
        state: SharedWindowState,
        events: EventSink,
        evidence: Evidence,
    ) -> Self {
        Self {
            window_id,
            state,
            inputs: BTreeMap::new(),
            buttons: BTreeMap::new(),
            events,
            evidence,
        }
    }

    /// Called synchronously after complete transaction preflight. This method
    /// does not yield or dispatch native input between model and entity updates.
    pub(crate) fn apply(&mut self, tree: Tree, window: &mut Window, cx: &mut Context<Self>) {
        self.state.borrow_mut().tree = tree;
        // Snapshot cheap Arc-backed properties before focus/IME notifications:
        // native callbacks must never run while the shared model is borrowed.
        let controls: BTreeMap<_, _> = self
            .state
            .borrow()
            .tree
            .nodes()
            .filter(|(_, node)| {
                matches!(
                    node.element(),
                    NativeElement::Input { .. } | NativeElement::Button { .. }
                )
            })
            .map(|(id, node)| (id, node.clone()))
            .collect();
        self.inputs.retain(|id, input| {
            if controls.contains_key(id) {
                return true;
            }
            if input.focus_handle(cx).is_focused(window) {
                window.blur(cx);
            }
            false
        });
        self.buttons.retain(|id, focus| {
            let enabled = controls.get(id).is_some_and(|node| {
                matches!(
                    node.element(),
                    NativeElement::Button {
                        disabled: false,
                        ..
                    }
                )
            });
            if !enabled && focus.is_focused(window) {
                window.blur(cx);
            }
            controls.contains_key(id)
        });
        for (node_id, node) in controls {
            match node.element() {
                NativeElement::Input {
                    value, placeholder, ..
                } => {
                    if let Some(input) = self.inputs.get(&node_id) {
                        input.update(cx, |input, cx| {
                            input.set_properties(value, placeholder, window, cx)
                        });
                    } else {
                        let binding = InputBinding {
                            state: Rc::downgrade(&self.state),
                            window_id: self.window_id,
                            node_id,
                            events: self.events.clone(),
                        };
                        let input = cx.new(|cx| {
                            TextInput::new(value.clone(), placeholder.clone(), binding, cx)
                        });
                        if window.focused(cx).is_none() {
                            window.focus(&input.focus_handle(cx), cx);
                        }
                        self.inputs.insert(node_id, input);
                    }
                }
                NativeElement::Button { .. } => {
                    self.buttons
                        .entry(node_id)
                        .or_insert_with(|| cx.focus_handle());
                }
                NativeElement::Box { .. } | NativeElement::Text { .. } => {}
            }
        }
        cx.notify();
    }

    fn click(&self, node_id: NodeId, cx: &mut Context<Self>) {
        let state = self.state.borrow();
        if state.active
            && state.tree.node(node_id).is_some_and(|node| {
                matches!(
                    node.element(),
                    NativeElement::Button {
                        disabled: false,
                        ..
                    }
                )
            })
        {
            self.events.ui(
                |sequence| Event::Click {
                    sequence,
                    window_id: self.window_id,
                    node_id,
                },
                cx,
            );
        }
    }

    fn render_node(&self, tree: &Tree, node_id: NodeId, cx: &mut Context<Self>) -> AnyElement {
        let node = tree
            .node(node_id)
            .expect("validated tree contains every child");
        let base = div().id(node_id.get()).flex_shrink_0();
        match node.element() {
            NativeElement::Box { style: properties } => {
                let base = if node_id == tree.root_id() {
                    base.size_full()
                } else {
                    base
                };
                style::apply(base.flex().flex_col(), properties)
                    .children(
                        node.children()
                            .iter()
                            .map(|child| self.render_node(tree, *child, cx)),
                    )
                    .into_any_element()
            }
            NativeElement::Text {
                text,
                style: properties,
            } => style::apply(base, properties)
                .child(text.clone())
                .into_any_element(),
            NativeElement::Button {
                text,
                disabled,
                style: properties,
            } => {
                let mut button = style::apply(
                    base.flex()
                        .items_center()
                        .justify_center()
                        .h(px(44.))
                        .px(px(12.))
                        .bg(rgb(if *disabled { 0x7a8396 } else { 0x2255cc }))
                        .text_color(rgb(0xffffff)),
                    properties,
                )
                .child(text.clone());
                if !disabled {
                    let focus = self
                        .buttons
                        .get(&node_id)
                        .expect("button reconciled before render")
                        .clone();
                    button = button
                        .track_focus(&focus)
                        .key_context("NativeButton")
                        .cursor_pointer()
                        .on_mouse_down(MouseButton::Left, move |_, window, cx| {
                            window.focus(&focus, cx)
                        })
                        .on_click(cx.listener(move |view, _, _, cx| view.click(node_id, cx)))
                        .on_action(cx.listener(move |view, _: &ActivateButton, _, cx| {
                            view.click(node_id, cx)
                        }));
                }
                button.into_any_element()
            }
            NativeElement::Input {
                style: properties, ..
            } => style::apply(base, properties)
                .child(
                    self.inputs
                        .get(&node_id)
                        .expect("input reconciled before render")
                        .clone(),
                )
                .into_any_element(),
        }
    }
}

impl Render for NativeView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let state = self.state.borrow();
        let body = self.render_node(&state.tree, state.tree.root_id(), cx);
        let evidence = self.evidence.clone();
        let paint_state = self.state.clone();
        let window_id = self.window_id;
        div()
            .size_full()
            .relative()
            .overflow_hidden()
            .bg(rgb(0xffffff))
            .text_color(rgb(0x17212b))
            .text_size(px(18.))
            .child(body)
            .child(
                canvas(
                    |_, _, _| (),
                    move |_, (), _, _| {
                        evidence.painted(window_id, &paint_state.borrow().tree);
                    },
                )
                .absolute()
                .top_0()
                .left_0()
                .size(px(1.)),
            )
    }
}
