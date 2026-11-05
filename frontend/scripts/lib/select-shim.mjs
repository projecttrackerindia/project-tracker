// The app's themed <Select> renders a combobox button with the hidden native <select> right after it (the source of truth).
// Older checks call locator.selectOption()/inputValue() on what getByLabel() finds, which is now the button: redirect those
// calls to the native select beside it, so every check keeps driving real change events.
export async function shimSelect(browser) {
  const ctx = await browser.newContext(); const page = await ctx.newPage();
  const proto = Object.getPrototypeOf(page.locator('body'));
  await ctx.close();
  if (proto.__ssShim) return; proto.__ssShim = true;
  const native = async (loc) => ((await loc.evaluate((e) => e.classList?.contains('ss-trigger')).catch(() => false)) ? loc.locator('xpath=following-sibling::select[1]') : null);
  const sel = proto.selectOption, val = proto.inputValue;
  proto.selectOption = async function (v, o) { const n = await native(this); return n ? sel.call(n, v, { ...o, force: true }) : sel.call(this, v, o); };
  proto.inputValue = async function (o) { const n = await native(this); return n ? val.call(n, o) : val.call(this, o); };
}
