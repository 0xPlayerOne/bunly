use crate::{Command, Event, MAX_FRAME_BYTES};
use std::fmt;
use std::io::{self, BufRead, Write};

#[derive(Debug)]
pub enum ProtocolError {
    Io(io::Error),
    InvalidJson(serde_json::Error),
    InvalidCommand(&'static str),
    Oversized,
    Truncated,
    Poisoned,
}

impl fmt::Display for ProtocolError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => write!(formatter, "channel I/O failed: {error}"),
            Self::InvalidJson(error) => write!(formatter, "invalid JSON frame: {error}"),
            Self::InvalidCommand(message) => formatter.write_str(message),
            Self::Oversized => formatter.write_str("frame exceeds 65536 bytes"),
            Self::Truncated => formatter.write_str("channel ended within a frame"),
            Self::Poisoned => formatter.write_str("channel is poisoned"),
        }
    }
}

impl std::error::Error for ProtocolError {}

/// Owns at most one bounded frame. Reading cannot grow with an untrusted line.
#[derive(Default)]
pub struct CommandReader {
    poisoned: bool,
    finished: bool,
}

impl CommandReader {
    pub fn read(&mut self, source: &mut impl BufRead) -> Result<Option<Command>, ProtocolError> {
        if self.poisoned {
            return Err(ProtocolError::Poisoned);
        }
        if self.finished {
            return Ok(None);
        }
        let result = self.read_inner(source);
        if result.is_err() {
            self.poisoned = true;
        }
        if matches!(result, Ok(None)) {
            self.finished = true;
        }
        result
    }

    fn read_inner(&mut self, source: &mut impl BufRead) -> Result<Option<Command>, ProtocolError> {
        let mut frame = Vec::new();
        loop {
            let available = source.fill_buf().map_err(ProtocolError::Io)?;
            if available.is_empty() {
                return if frame.is_empty() {
                    Ok(None)
                } else {
                    Err(ProtocolError::Truncated)
                };
            }
            let newline = available.iter().position(|byte| *byte == b'\n');
            let count = newline.unwrap_or(available.len());
            if frame.len() + count > MAX_FRAME_BYTES {
                return Err(ProtocolError::Oversized);
            }
            frame.extend_from_slice(&available[..count]);
            source.consume(count + usize::from(newline.is_some()));
            if newline.is_some() {
                // Match JSON.parse's last-member semantics for duplicate keys.
                // The frame bounds both passes. Parsing still rejects invalid
                // UTF-8, BOMs, empty frames and trailing junk; typed conversion
                // then rejects unknown fields and invalid command shapes.
                let value: serde_json::Value =
                    serde_json::from_slice(&frame).map_err(ProtocolError::InvalidJson)?;
                let command: Command =
                    serde_json::from_value(value).map_err(ProtocolError::InvalidJson)?;
                command.validate().map_err(ProtocolError::InvalidCommand)?;
                return Ok(Some(command));
            }
        }
    }
}

/// Writes one complete event and flushes before returning. Never logs on stdout.
pub fn write_event(sink: &mut impl Write, event: &Event) -> Result<(), ProtocolError> {
    let mut bytes = serde_json::to_vec(event).map_err(ProtocolError::InvalidJson)?;
    if bytes.len() > MAX_FRAME_BYTES {
        return Err(ProtocolError::Oversized);
    }
    bytes.push(b'\n');
    sink.write_all(&bytes).map_err(ProtocolError::Io)?;
    sink.flush().map_err(ProtocolError::Io)
}
