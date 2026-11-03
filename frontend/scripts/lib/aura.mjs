// Aura in the calm shell: the header orb (the top bar's orb on a phone) or ⌘K opens the Aura panel (floating on a wide screen, a bottom
// sheet on a phone) on its Chat tab. There is no bottom capsule any more.
/** Opens the Aura panel and returns its field (a textarea). A no-op when it is already open. */
export async function invokeAura(page) {
  const field = page.locator('.groot-chat textarea[data-aura-input]');
  if (await field.count()) return field;
  await page.locator('.v2-tb .shell-orb, .m-top .m-aura-orb').first().click();
  await field.waitFor();
  return field;
}
/** The same panel (kept for scripts written for the old side panel). */
export async function openAuraPanel(page) {
  await invokeAura(page);
}
