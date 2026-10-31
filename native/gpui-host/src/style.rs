use bun_native_protocol::{Dimension, Direction, Style};
use gpui::{Styled, px, relative, rgb};

/// Values have already passed protocol bounds. Convert to GPUI pixels only
/// here, after f64 validation, so rounding cannot admit out-of-range values.
pub(crate) fn apply<T: Styled>(mut element: T, style: &Style) -> T {
    if let Some(direction) = style.direction {
        element = match direction {
            Direction::Row => element.flex().flex_row(),
            Direction::Column => element.flex().flex_col(),
        };
    }
    if let Some(gap) = style.gap {
        element = element.gap(px(gap as f32));
    }
    if let Some(padding) = style.padding {
        element = element.p(px(padding as f32));
    }
    if let Some(width) = style.width {
        element = match width {
            Dimension::Pixels(value) => element.w(px(value as f32)),
            Dimension::Fill(_) => element.w(relative(1.)),
        };
    }
    if let Some(height) = style.height {
        element = match height {
            Dimension::Pixels(value) => element.h(px(value as f32)),
            Dimension::Fill(_) => element.h(relative(1.)),
        };
    }
    if let Some(grow) = style.flex_grow {
        element = element.flex_grow(grow as f32);
    }
    if let Some(background) = style.background {
        element = element.bg(rgb(background));
    }
    if let Some(color) = style.color {
        element = element.text_color(rgb(color));
    }
    if let Some(size) = style.font_size {
        element = element.text_size(px(size as f32));
    }
    element
}
