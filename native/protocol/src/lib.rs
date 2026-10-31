//! Bun Native's bounded, versioned private host protocol and atomic tree model.
//! Protocol 2 replaces the BN0 fixture protocol; there is no fallback decoder.

mod framing;
mod tree;
mod wire;

pub use framing::{write_event, CommandReader, ProtocolError};
pub use tree::{BatchMetrics, ModelError, Node, PreparedBatch, Tree};
pub use wire::*;

#[cfg(test)]
mod security_tests;
#[cfg(test)]
mod tests;
