mod channel;
mod evidence;
mod input;
mod session;
mod state;
mod style;
mod view;

use bun_native_protocol::{ErrorCode, Event};
use channel::Incoming;
use gpui::{App, QuitMode};
use session::Session;

fn main() {
    let (commands, events) = channel::connect();
    let evidence = evidence::Evidence::from_environment();
    gpui_platform::application()
        .with_quit_mode(QuitMode::Explicit)
        .run(move |cx: &mut App| {
            input::bind_keys(cx);
            view::bind_keys(cx);
            let mut session = Session::new(events, evidence, cx);
            cx.spawn(async move |cx| {
                while let Ok(incoming) = commands.recv().await {
                    cx.update(|cx| match incoming {
                        Incoming::Command(command) => session.dispatch(command, cx),
                        Incoming::InvalidFrame => session.finish(
                            Event::Error {
                                id: None,
                                code: ErrorCode::InvalidCommand,
                                message: "invalid, oversized or truncated command frame".into(),
                            },
                            cx,
                        ),
                        Incoming::Disconnected => session.disconnect(cx),
                    });
                    if session.finishing() {
                        break;
                    }
                }
            })
            .detach();
        });
}
