// Aura is invoked Siri style (nothing of it on screen at rest): these bring up the floating capsule, or the full side panel from its orb.
/** Brings up the capsule: the toolbar's "Aura ⌘K" hint on a wide screen, the top bar's orb on a phone. A no-op when it is already up. */
export async function invokeAura(page) {
  const field = page.getByTestId('aura-dock').getByRole('combobox');
  if (await field.count()) return field;
  await page.locator('.v2-tb .aura-hint, .m-top .m-aura-orb').first().click();
  await field.waitFor();
  return field;
}
/** Opens the Aura side panel (the capsule's orb). */
export async function openAuraPanel(page) {
  await invokeAura(page);
  await page.getByTestId('aura-dock').getByRole('button', { name: 'Open Aura' }).click();
}
