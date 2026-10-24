//! 自绘小部件：按钮 / 胶囊标签 / 进度条 / 开关 / 卡片。
//!
//! 全部手绘（而不是用 egui 默认控件）是为了统一圆角、字重、悬停过渡，
//! 让界面看起来像一款正经的桌面应用，而不是「表单网页」。

use egui::{Color32, CursorIcon, FontId, Response, Rounding, Sense, Stroke, Ui, Vec2};

use crate::theme::*;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Btn {
    Primary,
    Secondary,
    Ghost,
    Danger,
}

pub fn button(ui: &mut Ui, label: &str, kind: Btn, enabled: bool) -> Response {
    let font = FontId::proportional(13.0);
    let galley =
        ui.painter()
            .layout_no_wrap(label.to_owned(), font.clone(), egui::Color32::PLACEHOLDER);
    let pad = Vec2::new(14.0, 6.0);
    let size = Vec2::new(
        galley.size().x + pad.x * 2.0,
        (galley.size().y + pad.y * 2.0).max(30.0),
    );
    let sense = if enabled {
        Sense::click()
    } else {
        Sense::hover()
    };
    let (rect, resp) = ui.allocate_exact_size(size, sense);
    let hovered = enabled && resp.hovered();
    let rounding = Rounding::same(8.0);

    let (bg, fg, stroke) = match kind {
        Btn::Primary => (
            if !enabled {
                tint(ACCENT, 70)
            } else if hovered {
                ACCENT_HOVER
            } else {
                ACCENT
            },
            if enabled {
                egui::Color32::WHITE
            } else {
                tint(egui::Color32::WHITE, 140)
            },
            None,
        ),
        Btn::Secondary => (
            if hovered {
                egui::Color32::from_rgb(44, 50, 62)
            } else {
                egui::Color32::from_rgb(35, 40, 50)
            },
            if enabled { TEXT } else { FAINT },
            Some(Stroke::new(
                1.0_f32,
                if hovered {
                    egui::Color32::from_rgb(60, 68, 84)
                } else {
                    BORDER
                },
            )),
        ),
        Btn::Ghost => (
            if hovered {
                egui::Color32::from_rgb(34, 39, 49)
            } else {
                egui::Color32::TRANSPARENT
            },
            if enabled { MUTED } else { FAINT },
            None,
        ),
        Btn::Danger => (
            if hovered {
                tint(ERR, 40)
            } else {
                Color32::TRANSPARENT
            },
            ERR,
            Some(Stroke::new(
                1.0_f32,
                if hovered {
                    tint(ERR, 160)
                } else {
                    tint(ERR, 90)
                },
            )),
        ),
    };

    ui.painter().rect_filled(rect, rounding, bg);
    if let Some(s) = stroke {
        ui.painter().rect_stroke(rect, rounding, s);
    }
    let text_pos = rect.center() - galley.size() / 2.0;
    ui.painter().galley(text_pos, galley, fg);
    if hovered {
        ui.ctx().set_cursor_icon(CursorIcon::PointingHand);
    }
    resp
}

pub fn chip(ui: &mut Ui, text: &str, fg: egui::Color32, bg: egui::Color32) -> Response {
    let font = FontId::proportional(12.0);
    let galley = ui
        .painter()
        .layout_no_wrap(text.to_owned(), font, egui::Color32::PLACEHOLDER);
    let pad = Vec2::new(8.0, 3.0);
    let size = Vec2::new(galley.size().x + pad.x * 2.0, galley.size().y + pad.y * 2.0);
    let (rect, resp) = ui.allocate_exact_size(size, Sense::hover());
    ui.painter()
        .rect_filled(rect, Rounding::same(size.y / 2.0), bg);
    ui.painter()
        .galley(rect.center() - galley.size() / 2.0, galley, fg);
    resp
}

pub fn dot(ui: &mut Ui, color: egui::Color32, glow: bool) -> Response {
    let (rect, resp) = ui.allocate_exact_size(Vec2::splat(10.0), Sense::hover());
    if glow {
        ui.painter()
            .circle_filled(rect.center(), 6.0, tint(color, 40));
        ui.painter().circle_filled(rect.center(), 3.5, color);
    } else {
        ui.painter().circle_filled(rect.center(), 3.5, color);
    }
    resp
}

/// 进度条：底槽 + 圆角填充；`striped` 时叠加斜纹（核验阶段用）。
pub fn progress(
    ui: &mut Ui,
    frac: f32,
    color: Color32,
    height: f32,
    animated_pulse: bool,
) -> Response {
    let width = ui.available_width();
    let (rect, resp) = ui.allocate_exact_size(Vec2::new(width, height), Sense::hover());
    let rounding = Rounding::same(height / 2.0);
    ui.painter()
        .rect_filled(rect, rounding, Color32::from_rgb(38, 43, 53));
    let f = frac.clamp(0.0, 1.0);
    if f > 0.0 {
        let mut fill = rect;
        fill.set_width((rect.width() * f).max(height));
        ui.painter().rect_filled(fill, rounding, color);
        if animated_pulse {
            let t = ui.input(|i| i.time) as f32;
            let alpha = ((t * 2.4).sin() * 0.5 + 0.5) * 60.0;
            ui.painter()
                .rect_filled(fill, rounding, Color32::from_white_alpha(alpha as u8));
        }
    }
    resp
}

/// 开关（switch）——比 checkbox 更像桌面应用；整行可点。
pub fn toggle(ui: &mut Ui, value: &mut bool, label: &str) -> Response {
    let width = ui.available_width();
    let (rect, resp) = ui.allocate_exact_size(Vec2::new(width, 26.0), Sense::click());
    let track = egui::Rect::from_min_size(rect.left_top(), Vec2::new(36.0, 20.0));
    let on = *value;
    let bg = if on {
        ACCENT
    } else {
        Color32::from_rgb(46, 52, 64)
    };
    ui.painter().rect_filled(track, Rounding::same(10.0), bg);
    let knob_x = if on {
        track.right() - 10.0
    } else {
        track.left() + 10.0
    };
    ui.painter().circle_filled(
        egui::pos2(knob_x, track.center().y),
        7.0,
        egui::Color32::WHITE,
    );

    let galley = ui.painter().layout_no_wrap(
        label.to_owned(),
        FontId::proportional(13.0),
        egui::Color32::PLACEHOLDER,
    );
    let text_pos = egui::pos2(
        track.right() + 10.0,
        rect.center().y - galley.size().y / 2.0,
    );
    ui.painter()
        .galley(text_pos, galley, if resp.hovered() { TEXT } else { MUTED });

    if resp.clicked() {
        *value = !*value;
    }
    if resp.hovered() {
        ui.ctx().set_cursor_icon(CursorIcon::PointingHand);
    }
    resp
}

/// 卡片容器（背景 + 1px 边框 + 圆角 + 内边距）。
pub fn card(ui: &mut Ui, add: impl FnOnce(&mut Ui)) {
    egui::Frame::none()
        .fill(CARD)
        .stroke(Stroke::new(1.0_f32, BORDER_SOFT))
        .rounding(Rounding::same(12.0))
        .inner_margin(egui::Margin::same(14.0))
        .show(ui, |ui| {
            ui.set_width(ui.available_width());
            add(ui);
        });
}

pub fn section_title(ui: &mut Ui, title: &str, hint: Option<&str>) {
    ui.horizontal(|ui| {
        ui.label(egui::RichText::new(title).size(14.0).color(TEXT).strong());
        if let Some(h) = hint {
            ui.add_space(2.0);
            ui.label(egui::RichText::new(h).size(12.0).color(FAINT));
        }
    });
}

/// 把长文本按可用宽度粗略截断（中文按 1 字宽、ASCII 按 0.55 字宽估算）。
pub fn truncate(s: &str, max_px: f32, font_px: f32) -> String {
    let mut acc = 0.0;
    let mut out = String::new();
    for ch in s.chars() {
        let w = if ch.is_ascii() {
            font_px * 0.55
        } else {
            font_px
        };
        if acc + w > max_px {
            out.push('…');
            return out;
        }
        acc += w;
        out.push(ch);
    }
    out
}
