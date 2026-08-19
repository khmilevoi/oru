import {
  colors,
  fonts,
  radii,
  routeReadout,
  segmented,
  testIds,
  type,
} from '../src/ui/theme';

describe('theme tokens for the section 8 surfaces', () => {
  it('carries the canvas .routeline metrics', () => {
    // design/01 Radio.dc.html: font-size 11px, letter-spacing 0.14em, --faint.
    expect(type.routeLabel.fontSize).toBe(11);
    expect(type.routeLabel.letterSpacing).toBe(1.54);
    expect(type.routeLabel.fontFamily).toBe(fonts.mono);
    expect(colors.textFaint).toBe('#57626c');
  });

  it('carries the canvas .route geometry', () => {
    // design/01 Radio.dc.html: gap 9px, 14x14 icon at stroke-width 1.5,
    // left/right 90px, bottom 44px.
    expect(routeReadout).toEqual({
      gap: 9,
      iconSize: 14,
      strokeWidth: 1.5,
      sideInset: 90,
      bottomInset: 44,
    });
  });

  it('carries the canvas .seg metrics', () => {
    // design/02 Settings.dc.html: 13.5px, 0.04em, radius 14px, padding 14px 0,
    // selected is --ink on #0c0e10 at weight 500.
    expect(type.segment.fontSize).toBe(13.5);
    expect(type.segment.letterSpacing).toBe(0.54);
    expect(type.segment.fontFamily).toBe(fonts.mono);
    expect(type.segmentSelected.fontFamily).toBe(fonts.monoMedium);
    expect(type.segmentSelected.fontSize).toBe(type.segment.fontSize);
    expect(segmented.paddingVertical).toBe(14);
    expect(radii.md).toBe(14);
    expect(colors.hairlineRaised).toBe('#2e363e');
    expect(colors.textInverse).toBe('#0c0e10');
  });

  it('appends the two new test ids without renaming any existing one', () => {
    expect(testIds.audioRoute).toBe('audio-route');
    expect(testIds.audioMode).toBe('audio-mode');
    expect(testIds.radioScreen).toBe('radio-screen');
    expect(testIds.settingsScreen).toBe('settings-screen');
  });
});
