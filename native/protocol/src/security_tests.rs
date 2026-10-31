//! Shared adversarial wire fixtures. These exercise the real Rust decoder and
//! validators; they do not stand in for a GPUI render or an OS service grant.

use crate::{CommandReader, ProtocolError, PROTOCOL_VERSION};
use serde::Deserialize;
use std::collections::BTreeSet;
use std::io::Cursor;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Fixtures {
    protocol: u32,
    scope: String,
    cases: Vec<Case>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Case {
    name: String,
    category: String,
    wire: String,
    outcome: Outcome,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum Outcome {
    Accept,
    Reject,
}

#[test]
fn shared_adversarial_commands_match_typescript_and_poison_invalid_sessions() {
    let fixtures: Fixtures =
        serde_json::from_str(include_str!("../../../tests/fixtures/bridge-security.json"))
            .expect("valid shared security fixtures");
    assert_eq!(fixtures.protocol, PROTOCOL_VERSION);
    assert!(!fixtures.scope.is_empty());
    let mut names = BTreeSet::new();
    for case in fixtures.cases {
        assert!(names.insert(case.name.clone()), "duplicate fixture name");
        assert!(!case.category.is_empty(), "missing risk category");
        let bytes = format!("{}\n", case.wire);
        let mut source = Cursor::new(bytes.as_bytes());
        let mut reader = CommandReader::default();
        let result = reader.read(&mut source);
        match case.outcome {
            Outcome::Accept => {
                assert!(matches!(result, Ok(Some(_))), "{}: {result:?}", case.name);
                assert!(matches!(reader.read(&mut source), Ok(None)));
            }
            Outcome::Reject => {
                assert!(result.is_err(), "{} was accepted", case.name);
                let mut valid = Cursor::new(b"{\"id\":1,\"type\":\"shutdown\"}\n");
                assert!(
                    matches!(reader.read(&mut valid), Err(ProtocolError::Poisoned)),
                    "{} left an invalid native session usable",
                    case.name
                );
            }
        }
    }
}
