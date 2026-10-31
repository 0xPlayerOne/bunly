//! Atomic tree transactions independent of GPUI. Native UI mutation follows
//! successful preparation, so invalid input cannot partially alter a window.

use crate::{
    validate_text, Element, ErrorCode, NodeId, Operation, Style, MAX_DEPTH, MAX_ID,
    MAX_NODES_PER_WINDOW, MAX_OPERATIONS, MAX_TEXT_BYTES_PER_WINDOW,
};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::sync::Arc;
use std::time::Instant;

#[derive(Debug, Clone, PartialEq)]
pub struct Node {
    element: Arc<Element>,
    parent: Option<NodeId>,
    children: Vec<NodeId>,
    input_revision: Option<u64>,
}

impl Node {
    pub fn element(&self) -> &Element {
        &self.element
    }
    pub fn children(&self) -> &[NodeId] {
        &self.children
    }
    pub fn input_revision(&self) -> Option<u64> {
        self.input_revision
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Tree {
    root_id: NodeId,
    revision: u64,
    text_bytes: usize,
    nodes: BTreeMap<NodeId, Node>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ModelError {
    pub code: ErrorCode,
    pub message: &'static str,
}

impl fmt::Display for ModelError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.message)
    }
}
impl std::error::Error for ModelError {}

#[derive(Debug, Clone, Serialize)]
pub struct BatchMetrics {
    pub operation_count: usize,
    pub node_count: usize,
    pub text_bytes: usize,
    pub preflight_nanos: u64,
}

pub struct PreparedBatch {
    pub tree: Tree,
    pub last_node_id: u64,
    pub metrics: BatchMetrics,
}

fn error(code: ErrorCode, message: &'static str) -> ModelError {
    ModelError { code, message }
}
fn invalid_handle() -> ModelError {
    error(
        ErrorCode::InvalidHandle,
        "node is stale or is not owned by this window",
    )
}
fn next_revision(current: u64) -> Result<u64, ModelError> {
    if current >= MAX_ID {
        Err(error(ErrorCode::LimitExceeded, "revision exhausted"))
    } else {
        Ok(current + 1)
    }
}

fn text_budget(bytes: usize) -> Result<usize, ModelError> {
    if bytes > MAX_TEXT_BYTES_PER_WINDOW {
        Err(error(
            ErrorCode::LimitExceeded,
            "window text byte limit exceeded",
        ))
    } else {
        Ok(bytes)
    }
}

impl Tree {
    pub fn new(root_id: NodeId) -> Self {
        Self {
            root_id,
            revision: 0,
            text_bytes: 0,
            nodes: BTreeMap::from([(
                root_id,
                Node {
                    element: Arc::new(Element::Box {
                        style: Style::default(),
                    }),
                    parent: None,
                    children: Vec::new(),
                    input_revision: None,
                },
            )]),
        }
    }

    pub fn root_id(&self) -> NodeId {
        self.root_id
    }
    pub fn revision(&self) -> u64 {
        self.revision
    }
    pub fn node(&self, id: NodeId) -> Option<&Node> {
        self.nodes.get(&id)
    }
    pub fn nodes(&self) -> impl Iterator<Item = (NodeId, &Node)> {
        self.nodes.iter().map(|(id, node)| (*id, node))
    }

    /// `last_node_id` is the session-wide committed high-water mark. Neither
    /// this tree nor that counter changes when any operation is rejected.
    pub fn prepare(
        &self,
        base_revision: u64,
        operations: Vec<Operation>,
        mut last_node_id: u64,
    ) -> Result<PreparedBatch, ModelError> {
        let started = Instant::now();
        if base_revision != self.revision {
            return Err(error(
                ErrorCode::StaleRevision,
                "tree revision does not match",
            ));
        }
        if operations.is_empty() || operations.len() > MAX_OPERATIONS {
            return Err(error(
                ErrorCode::LimitExceeded,
                "batch must have between 1 and 256 operations",
            ));
        }
        if last_node_id > MAX_ID
            || self
                .nodes
                .keys()
                .next_back()
                .is_some_and(|id| id.get() > last_node_id)
        {
            return Err(error(
                ErrorCode::InvalidState,
                "session allocation state is inconsistent",
            ));
        }
        let operation_count = operations.len();
        // Property payloads are immutable Arc values: cloning the bounded graph
        // copies its links, not every text string on each keypress or update.
        let mut next = self.clone();
        for operation in operations {
            match operation {
                Operation::Create { node_id, element } => {
                    element
                        .validate()
                        .map_err(|message| error(ErrorCode::InvalidCommand, message))?;
                    if node_id.get() <= last_node_id {
                        return Err(error(
                            ErrorCode::InvalidHandle,
                            "node IDs must increase across the session and cannot be reused",
                        ));
                    }
                    if next.nodes.len() >= MAX_NODES_PER_WINDOW {
                        return Err(error(
                            ErrorCode::LimitExceeded,
                            "window node limit exceeded",
                        ));
                    }
                    let input_revision = matches!(element, Element::Input { .. }).then_some(0);
                    next.text_bytes = text_budget(next.text_bytes + element.text_bytes())?;
                    next.nodes.insert(
                        node_id,
                        Node {
                            element: Arc::new(element),
                            parent: None,
                            children: Vec::new(),
                            input_revision,
                        },
                    );
                    last_node_id = node_id.get();
                }
                Operation::Set {
                    node_id,
                    element,
                    expected_input_revision,
                } => {
                    element
                        .validate()
                        .map_err(|message| error(ErrorCode::InvalidCommand, message))?;
                    let node = next.nodes.get_mut(&node_id).ok_or_else(invalid_handle)?;
                    if !node.element.same_kind(&element) {
                        return Err(error(
                            ErrorCode::InvalidState,
                            "set cannot change an element kind",
                        ));
                    }
                    match (node.input_revision, expected_input_revision) {
                        (Some(current), Some(expected)) if current == expected => {
                            node.input_revision = Some(next_revision(current)?)
                        }
                        (Some(_), Some(_)) => {
                            return Err(error(
                                ErrorCode::StaleRevision,
                                "input revision does not match",
                            ))
                        }
                        (Some(_), None) => {
                            return Err(error(
                                ErrorCode::InvalidCommand,
                                "input set requires expected_input_revision",
                            ))
                        }
                        (None, Some(_)) => {
                            return Err(error(
                                ErrorCode::InvalidCommand,
                                "expected_input_revision is only valid for input",
                            ))
                        }
                        (None, None) => {}
                    }
                    next.text_bytes = text_budget(
                        next.text_bytes - node.element.text_bytes() + element.text_bytes(),
                    )?;
                    node.element = Arc::new(element);
                }
                Operation::Insert {
                    parent_id,
                    child_id,
                    index,
                } => next.insert(parent_id, child_id, index)?,
                Operation::Delete { node_id } => next.delete(node_id)?,
            }
        }
        next.validate_graph()?;
        next.revision = next_revision(self.revision)?;
        let metrics = BatchMetrics {
            operation_count,
            node_count: next.nodes.len(),
            text_bytes: next.text_bytes,
            preflight_nanos: started.elapsed().as_nanos().min(MAX_ID as u128) as u64,
        };
        Ok(PreparedBatch {
            tree: next,
            last_node_id,
            metrics,
        })
    }

    /// Native editing advances only this input's revision, so typing cannot
    /// invalidate an unrelated text/style transaction. Equal content is not an
    /// edit; composition selection updates may still repaint without an event.
    pub fn replace_input(
        &mut self,
        node_id: NodeId,
        value: String,
    ) -> Result<Option<u64>, ModelError> {
        validate_text(&value).map_err(|message| error(ErrorCode::InvalidCommand, message))?;
        let node = self.nodes.get_mut(&node_id).ok_or_else(invalid_handle)?;
        let Element::Input { value: old, .. } = node.element.as_ref() else {
            return Err(error(ErrorCode::InvalidState, "node is not an input"));
        };
        if *old == value {
            return Ok(None);
        }
        let revision = next_revision(node.input_revision.ok_or_else(invalid_handle)?)?;
        let text_bytes = text_budget(self.text_bytes - old.len() + value.len())?;
        if let Element::Input { value: old, .. } = Arc::make_mut(&mut node.element) {
            *old = value;
        }
        node.input_revision = Some(revision);
        self.text_bytes = text_bytes;
        Ok(Some(revision))
    }

    fn insert(
        &mut self,
        parent_id: NodeId,
        child_id: NodeId,
        index: usize,
    ) -> Result<(), ModelError> {
        let parent = self.nodes.get(&parent_id).ok_or_else(invalid_handle)?;
        if !matches!(parent.element.as_ref(), Element::Box { .. }) {
            return Err(error(
                ErrorCode::InvalidState,
                "only box elements can own children",
            ));
        }
        if child_id == self.root_id {
            return Err(error(
                ErrorCode::InvalidState,
                "the window root cannot be reparented",
            ));
        }
        let old_parent = self.nodes.get(&child_id).ok_or_else(invalid_handle)?.parent;
        let mut ancestor = Some(parent_id);
        while let Some(id) = ancestor {
            if id == child_id {
                return Err(error(
                    ErrorCode::InvalidState,
                    "insert would create a cycle",
                ));
            }
            ancestor = self.nodes.get(&id).ok_or_else(invalid_handle)?.parent;
        }
        if let Some(old_parent) = old_parent {
            self.nodes
                .get_mut(&old_parent)
                .ok_or_else(invalid_handle)?
                .children
                .retain(|id| *id != child_id);
        }
        let children = &mut self
            .nodes
            .get_mut(&parent_id)
            .ok_or_else(invalid_handle)?
            .children;
        if index > children.len() {
            return Err(error(
                ErrorCode::InvalidCommand,
                "insert index exceeds child count after detaching",
            ));
        }
        children.insert(index, child_id);
        self.nodes
            .get_mut(&child_id)
            .ok_or_else(invalid_handle)?
            .parent = Some(parent_id);
        Ok(())
    }

    fn delete(&mut self, node_id: NodeId) -> Result<(), ModelError> {
        if node_id == self.root_id {
            return Err(error(
                ErrorCode::InvalidState,
                "close the window to delete its root",
            ));
        }
        let parent = self.nodes.get(&node_id).ok_or_else(invalid_handle)?.parent;
        if let Some(parent) = parent {
            self.nodes
                .get_mut(&parent)
                .ok_or_else(invalid_handle)?
                .children
                .retain(|id| *id != node_id);
        }
        let mut pending = vec![node_id];
        while let Some(id) = pending.pop() {
            let node = self.nodes.remove(&id).ok_or_else(invalid_handle)?;
            self.text_bytes -= node.element.text_bytes();
            pending.extend(node.children);
        }
        Ok(())
    }

    fn validate_graph(&self) -> Result<(), ModelError> {
        let mut seen = BTreeSet::new();
        let mut pending = vec![(self.root_id, None, 0)];
        while let Some((id, parent, depth)) = pending.pop() {
            if depth > MAX_DEPTH {
                return Err(error(
                    ErrorCode::LimitExceeded,
                    "tree depth exceeds 64 edges",
                ));
            }
            if !seen.insert(id) {
                return Err(error(
                    ErrorCode::InvalidState,
                    "tree contains duplicate ownership or a cycle",
                ));
            }
            let node = self.nodes.get(&id).ok_or_else(invalid_handle)?;
            if node.parent != parent {
                return Err(error(
                    ErrorCode::InvalidState,
                    "tree parent and child ownership disagree",
                ));
            }
            for child in &node.children {
                pending.push((*child, Some(id), depth + 1));
            }
        }
        if seen.len() != self.nodes.len() {
            return Err(error(
                ErrorCode::InvalidState,
                "batch leaves detached nodes",
            ));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests;
