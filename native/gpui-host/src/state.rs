//! Shared only on GPUI's main thread. Input callbacks hold weak references and
//! consult `active`, so closing a window revokes callbacks before entity drops.

use bun_native_protocol::Tree;
use std::cell::RefCell;
use std::rc::Rc;

pub(crate) struct WindowState {
    pub(crate) tree: Tree,
    pub(crate) active: bool,
}

pub(crate) type SharedWindowState = Rc<RefCell<WindowState>>;
