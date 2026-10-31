use super::*;
use serde_json::{json, Value};
use std::io::{BufReader, Cursor};

fn request(value: u64) -> RequestId {
    RequestId::try_from(value).unwrap()
}
fn window(value: u64) -> WindowId {
    WindowId::try_from(value).unwrap()
}
fn node(value: u64) -> NodeId {
    NodeId::try_from(value).unwrap()
}
fn read(bytes: &[u8]) -> Result<Option<Command>, ProtocolError> {
    CommandReader::default().read(&mut Cursor::new(bytes))
}
fn read_json(value: &Value) -> Result<Option<Command>, ProtocolError> {
    read(format!("{value}\n").as_bytes())
}
fn batch(element: Value) -> Value {
    json!({"type":"batch","id":1,"window_id":1,"base_revision":0,"operations":[{"type":"create","node_id":2,"element":element}]})
}

#[test]
fn fragmented_utf8_and_multiple_frames_preserve_boundaries() {
    let bytes = "{\"id\":1,\"type\":\"open\",\"window_id\":1,\"root_id\":1,\"title\":\"界🌍\",\"width\":640,\"height\":480}\n{\"id\":2,\"type\":\"close\",\"window_id\":1}\n";
    let mut source = BufReader::with_capacity(1, Cursor::new(bytes.as_bytes()));
    let mut reader = CommandReader::default();
    assert!(
        matches!(reader.read(&mut source).unwrap(), Some(Command::Open { title, .. }) if title == "界🌍")
    );
    assert_eq!(
        reader.read(&mut source).unwrap(),
        Some(Command::Close {
            id: request(2),
            window_id: window(1)
        })
    );
    assert_eq!(reader.read(&mut source).unwrap(), None);
}

#[test]
fn invalid_frames_poison_the_reader() {
    for bytes in [
        b"\n".as_slice(),
        b"{}\n",
        b"\xff\n",
        b"\xef\xbb\xbf{}\n",
        b"null\n",
        b"{\"id\":1,\"type\":\"shutdown\"} junk\n",
        b"{\"id\":1,\"type\":\"shutdown\"}",
    ] {
        let mut source = Cursor::new(bytes);
        let mut reader = CommandReader::default();
        assert!(reader.read(&mut source).is_err(), "accepted {bytes:?}");
        assert!(matches!(
            reader.read(&mut source),
            Err(ProtocolError::Poisoned)
        ));
    }
}

#[test]
fn oversized_unterminated_frame_is_rejected_without_reading_to_eof() {
    let mut source = Cursor::new(vec![b' '; MAX_FRAME_BYTES + 1]);
    assert!(matches!(
        CommandReader::default().read(&mut source),
        Err(ProtocolError::Oversized)
    ));
    assert_eq!(source.position(), 0);
}

#[test]
fn exact_frame_limit_is_accepted() {
    let mut bytes = br#"{"id":1,"type":"shutdown"}"#.to_vec();
    bytes.resize(MAX_FRAME_BYTES, b' ');
    bytes.push(b'\n');
    assert_eq!(
        read(&bytes).unwrap(),
        Some(Command::Shutdown { id: request(1) })
    );
}

#[test]
fn malformed_ids_and_obsolete_commands_are_rejected() {
    for json in [
        r#"{"id":0,"type":"shutdown"}"#,
        r#"{"id":9007199254740992,"type":"shutdown"}"#,
        r#"{"id":1.5,"type":"shutdown"}"#,
        r#"{"id":-1,"type":"shutdown"}"#,
        r#"{"id":1,"type":"shutdown","unexpected":true}"#,
        r#"{"id":1,"type":"update","text":"legacy"}"#,
        r#"{"id":1,"type":"close","window_id":null}"#,
        r#"{"id":1,"type":"close","window_id":0}"#,
        r#"{"id":1,"type":"open","title":"legacy","text":"","input":""}"#,
    ] {
        assert!(
            read(format!("{json}\n").as_bytes()).is_err(),
            "accepted {json}"
        );
    }
}

#[test]
fn integer_number_spellings_match_javascript() {
    assert_eq!(
        read(b"{\"id\":1e0,\"type\":\"hello\",\"protocol\":2.0}\n").unwrap(),
        Some(Command::Hello {
            id: request(1),
            protocol: 2
        })
    );
    let command = read(b"{\"id\":2.0,\"type\":\"batch\",\"window_id\":1e0,\"base_revision\":0.0,\"operations\":[{\"type\":\"set\",\"node_id\":2.0,\"element\":{\"kind\":\"input\",\"value\":\"\",\"style\":{\"color\":1.0}},\"expected_input_revision\":0e0},{\"type\":\"insert\",\"parent_id\":1,\"child_id\":2,\"index\":0e0}]}\n").unwrap().unwrap();
    assert!(command.validate().is_ok());
}

#[test]
fn duplicate_keys_match_json_parse_last_member_semantics() {
    assert_eq!(
        read(b"{\"id\":0,\"id\":1,\"type\":\"close\",\"type\":\"shutdown\"}\n").unwrap(),
        Some(Command::Shutdown { id: request(1) })
    );
    assert!(read(b"{\"id\":1,\"id\":0,\"type\":\"shutdown\"}\n").is_err());
    assert!(read(b"{\"id\":1,\"type\":\"shutdown\",\"unknown\":1,\"unknown\":2}\n").is_err());
}

#[test]
fn window_bounds_and_titles_are_checked() {
    let valid = json!({"id":1,"type":"open","window_id":1,"root_id":1,"title":"Native","width":640,"height":480});
    assert!(read_json(&valid).is_ok());
    for (field, value) in [
        ("title", json!("")),
        ("title", json!("bad\nname")),
        ("title", json!("bad\u{85}name")),
        ("title", json!("界".repeat(86))),
        ("width", json!(63.9999999)),
        ("width", json!(16384.0001)),
        ("height", json!(-1)),
    ] {
        let mut invalid = valid.clone();
        invalid[field] = value;
        assert!(read_json(&invalid).is_err(), "accepted {invalid}");
    }
}

#[test]
fn style_limits_unknown_fields_and_null_values_are_rejected() {
    for style in [
        json!({"gap":4096.00001}),
        json!({"padding":-0.001}),
        json!({"width":16384.0001}),
        json!({"height":"auto"}),
        json!({"flex_grow":1000.00001}),
        json!({"font_size":0.99}),
        json!({"font_size":512.00001}),
        json!({"background":0x1000000}),
        json!({"color":1.1}),
        json!({"direction":"diagonal"}),
        json!({"padding":null}),
        json!({"color":null}),
        json!({"display":"none"}),
    ] {
        assert!(
            read_json(&batch(json!({"kind":"box","style":style}))).is_err(),
            "accepted {style}"
        );
    }
    for element in [
        json!({"kind":"box","style":null}),
        json!({"kind":"text","text":"hi","onClick":1}),
        json!({"kind":"input","value":"","placeholder":null}),
        json!({"kind":"button","text":"Go","disabled":null}),
    ] {
        assert!(
            read_json(&batch(element.clone())).is_err(),
            "accepted {element}"
        );
    }
    let all = json!({"direction":"row","gap":4096,"padding":0,"width":"fill","height":0,"flex_grow":1000,"background":0xffffff,"color":0,"font_size":512});
    assert!(read_json(&batch(json!({"kind":"box","style":all}))).is_ok());
    assert!(Style {
        gap: Some(f64::NAN),
        ..Style::default()
    }
    .validate()
    .is_err());
    assert!(Style {
        width: Some(Dimension::Pixels(f64::INFINITY)),
        ..Style::default()
    }
    .validate()
    .is_err());
}

#[test]
fn batches_enforce_revision_and_operation_shapes() {
    let mut empty = batch(json!({"kind":"box"}));
    empty["operations"] = json!([]);
    assert!(read_json(&empty).is_err());
    let mut huge = batch(json!({"kind":"box"}));
    huge["operations"] = json!(vec![
        json!({"type":"delete","node_id":2});
        MAX_OPERATIONS + 1
    ]);
    assert!(read_json(&huge).is_err());
    let mut invalid = batch(json!({"kind":"box"}));
    invalid["base_revision"] = json!(MAX_ID + 1);
    assert!(read_json(&invalid).is_err());
    for operation in [
        json!({"type":"set","node_id":2,"element":{"kind":"input","value":""}}),
        json!({"type":"set","node_id":2,"element":{"kind":"text","text":""},"expected_input_revision":0}),
        json!({"type":"set","node_id":2,"element":{"kind":"input","value":""},"expected_input_revision":null}),
        json!({"type":"insert","parent_id":1,"child_id":2,"index":4097}),
    ] {
        let mut invalid = batch(json!({"kind":"box"}));
        invalid["operations"] = json!([operation]);
        assert!(read_json(&invalid).is_err(), "accepted {invalid}");
    }
}

#[test]
fn eof_is_terminal_for_this_channel() {
    let mut reader = CommandReader::default();
    assert_eq!(reader.read(&mut Cursor::new(b"")).unwrap(), None);
    assert_eq!(
        reader
            .read(&mut Cursor::new(b"{\"id\":1,\"type\":\"shutdown\"}\n"))
            .unwrap(),
        None
    );
}

#[test]
fn text_limits_count_utf8_bytes_and_reject_nul_or_unpaired_surrogates() {
    assert!(read_json(&batch(
        json!({"kind":"text","text":"界".repeat(MAX_TEXT_BYTES / 3 + 1)})
    ))
    .is_err());
    assert!(read_json(&batch(
        json!({"kind":"input","value":"a".repeat(MAX_TEXT_BYTES)})
    ))
    .is_ok());
    assert!(read_json(&batch(json!({"kind":"input","value":"\u{0}"}))).is_err());
    assert!(read(b"{\"type\":\"open\",\"id\":1,\"window_id\":1,\"root_id\":1,\"title\":\"\\ud800\",\"width\":640,\"height\":480}\n").is_err());
}

#[test]
fn events_round_trip_with_single_newline_and_escaped_text() {
    let event = Event::Input {
        sequence: EventSequence::try_from(1).unwrap(),
        window_id: window(1),
        node_id: node(2),
        value: "line 1\nline 2 🌍".into(),
        input_revision: 1,
    };
    let mut bytes = Vec::new();
    write_event(&mut bytes, &event).unwrap();
    assert_eq!(bytes.iter().filter(|byte| **byte == b'\n').count(), 1);
    assert_eq!(serde_json::from_slice::<Event>(&bytes).unwrap(), event);
}

#[test]
fn absent_error_id_is_not_null() {
    let event = Event::Error {
        id: None,
        code: ErrorCode::InvalidState,
        message: "hello required".into(),
    };
    let mut bytes = Vec::new();
    write_event(&mut bytes, &event).unwrap();
    assert_eq!(
        String::from_utf8(bytes).unwrap(),
        "{\"type\":\"error\",\"code\":\"invalid_state\",\"message\":\"hello required\"}\n"
    );
}
