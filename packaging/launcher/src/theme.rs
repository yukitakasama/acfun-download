//! 主题：配色 / 字体 / 全局样式。
//!
//! 深色、低饱和背景 + 单一强调色（AcFun 粉红），圆角 8–14px，
//! 中文字体从系统字体目录加载（不随仓库分发字库，避免授权问题）。

use std::env;
use std::path::PathBuf;

use egui::{
    Color32, Context, FontData, FontDefinitions, FontFamily, FontId, Rounding, Stroke, TextStyle,
    Visuals,
};

// ---- 配色 ----
pub const BG: Color32 = Color32::from_rgb(15, 17, 22);
pub const CARD: Color32 = Color32::from_rgb(23, 26, 33);
pub const CARD_SOFT: Color32 = Color32::from_rgb(19, 22, 28);
pub const FIELD: Color32 = Color32::from_rgb(12, 14, 19);
pub const BORDER: Color32 = Color32::from_rgb(38, 43, 53);
pub const BORDER_SOFT: Color32 = Color32::from_rgb(30, 34, 42);
pub const TEXT: Color32 = Color32::from_rgb(231, 235, 242);
pub const MUTED: Color32 = Color32::from_rgb(139, 147, 167);
pub const FAINT: Color32 = Color32::from_rgb(92, 100, 120);
pub const ACCENT: Color32 = Color32::from_rgb(255, 84, 104);
pub const ACCENT_HOVER: Color32 = Color32::from_rgb(255, 111, 128);
pub const OK: Color32 = Color32::from_rgb(63, 208, 138);
pub const WARN: Color32 = Color32::from_rgb(240, 180, 41);
pub const ERR: Color32 = Color32::from_rgb(255, 92, 92);
pub const INFO: Color32 = Color32::from_rgb(76, 141, 255);

/// 12% 透明度的同色底（chip / 提示条用）。
pub fn tint(c: Color32, alpha: u8) -> Color32 {
    Color32::from_rgba_unmultiplied(c.r(), c.g(), c.b(), alpha)
}

pub fn apply(ctx: &Context) {
    let mut fonts = FontDefinitions::default();
    if let Some((name, bytes)) = load_cjk_font() {
        fonts
            .font_data
            .insert(name.clone(), FontData::from_owned(bytes));
        for family in [FontFamily::Proportional, FontFamily::Monospace] {
            fonts.families.entry(family).or_default().push(name.clone());
        }
    }
    ctx.set_fonts(fonts);

    let mut style = (*ctx.style()).clone();
    style.text_styles.insert(
        TextStyle::Heading,
        FontId::new(19.0, FontFamily::Proportional),
    );
    style
        .text_styles
        .insert(TextStyle::Body, FontId::new(14.0, FontFamily::Proportional));
    style.text_styles.insert(
        TextStyle::Button,
        FontId::new(13.5, FontFamily::Proportional),
    );
    style.text_styles.insert(
        TextStyle::Small,
        FontId::new(12.0, FontFamily::Proportional),
    );
    style.text_styles.insert(
        TextStyle::Monospace,
        FontId::new(12.5, FontFamily::Monospace),
    );

    style.spacing.item_spacing = egui::vec2(8.0, 8.0);
    style.spacing.button_padding = egui::vec2(12.0, 6.0);
    style.spacing.interact_size.y = 28.0;
    style.spacing.window_margin = egui::Margin::same(14.0);
    style.spacing.scroll.bar_width = 8.0;
    style.spacing.scroll.floating = true;

    let mut v = Visuals::dark();
    v.panel_fill = BG;
    v.window_fill = CARD;
    v.extreme_bg_color = FIELD;
    v.faint_bg_color = CARD_SOFT;
    v.window_stroke = Stroke::new(1.0_f32, BORDER);
    v.window_rounding = Rounding::same(14.0);
    v.menu_rounding = Rounding::same(10.0);
    v.hyperlink_color = INFO;
    v.selection.bg_fill = tint(ACCENT, 90);
    v.selection.stroke = Stroke::new(1.0_f32, ACCENT);
    v.override_text_color = Some(TEXT);

    let w = &mut v.widgets;
    w.noninteractive.bg_fill = CARD_SOFT;
    w.noninteractive.weak_bg_fill = CARD_SOFT;
    w.noninteractive.bg_stroke = Stroke::new(1.0_f32, BORDER_SOFT);
    w.noninteractive.fg_stroke = Stroke::new(1.0_f32, MUTED);
    w.noninteractive.rounding = Rounding::same(8.0);

    w.inactive.bg_fill = Color32::from_rgb(35, 40, 50);
    w.inactive.weak_bg_fill = Color32::from_rgb(30, 34, 43);
    w.inactive.bg_stroke = Stroke::new(1.0_f32, BORDER);
    w.inactive.fg_stroke = Stroke::new(1.0_f32, TEXT);
    w.inactive.rounding = Rounding::same(8.0);

    w.hovered.bg_fill = Color32::from_rgb(44, 50, 62);
    w.hovered.weak_bg_fill = Color32::from_rgb(38, 43, 54);
    w.hovered.bg_stroke = Stroke::new(1.0_f32, Color32::from_rgb(56, 63, 77));
    w.hovered.fg_stroke = Stroke::new(1.0_f32, Color32::WHITE);
    w.hovered.rounding = Rounding::same(8.0);

    w.active.bg_fill = Color32::from_rgb(52, 59, 73);
    w.active.weak_bg_fill = Color32::from_rgb(46, 52, 64);
    w.active.bg_stroke = Stroke::new(1.0_f32, Color32::from_rgb(70, 78, 95));
    w.active.fg_stroke = Stroke::new(1.0_f32, Color32::WHITE);
    w.active.rounding = Rounding::same(8.0);

    w.open.bg_fill = Color32::from_rgb(38, 43, 54);
    w.open.weak_bg_fill = Color32::from_rgb(38, 43, 54);
    w.open.bg_stroke = Stroke::new(1.0_f32, BORDER);
    w.open.fg_stroke = Stroke::new(1.0_f32, TEXT);
    w.open.rounding = Rounding::same(8.0);

    style.visuals = v;
    ctx.set_style(style);
}

/// 按优先级找系统中文字体：环境变量 > 微软雅黑 > 等线 > 黑体 > 宋体。
pub fn cjk_font_path() -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(custom) = env::var("ACFUN_UI_FONT") {
        candidates.push(PathBuf::from(custom));
    }
    let windir = env::var("WINDIR").unwrap_or_else(|_| "C:\\Windows".into());
    for name in [
        "msyh.ttc",
        "msyh.ttf",
        "Deng.ttf",
        "simhei.ttf",
        "simsun.ttc",
    ] {
        candidates.push(PathBuf::from(&windir).join("Fonts").join(name));
    }
    for path in candidates {
        if let Ok(meta) = std::fs::metadata(&path) {
            if meta.is_file() && meta.len() > 1024 {
                return Some(path);
            }
        }
    }
    None
}

fn load_cjk_font() -> Option<(String, Vec<u8>)> {
    let path = cjk_font_path()?;
    let bytes = std::fs::read(path).ok()?;
    Some(("acfun-cjk".to_string(), bytes))
}
