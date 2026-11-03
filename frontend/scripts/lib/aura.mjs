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
/** Opens the classic + New sheet (it understands the words: "Understood as a ticket") from the command palette's "Create…". The floating +'s
 *  New task now opens the calm New task sheet (features/calm/createSheets). */
export async function openCreate(page) {
  await page.locator('.v2-rail, .v2-phone-bar').first().waitFor(); await page.waitForTimeout(300);
  const pal = page.getByRole('dialog', { name: 'Command palette' });
  for (let i = 0; i < 5 && !(await pal.count()); i++) { await page.keyboard.press('Control+Shift+k'); await page.waitForTimeout(300); }
  await pal.waitFor();
  await page.waitForTimeout(100); await page.keyboard.type('Create'); await pal.getByText(/^Create… \(task/).first().click();
  await page.locator('.v2-new-sheet').waitFor();
}
