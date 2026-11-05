// Current signed-in shell and main places, against the seeded disposable API.
import assert from 'node:assert/strict';
import { go, start, waitFor } from './support.mjs';
const s = await start();
try {
  await go(s);
  // The calm Today is Home's default; the team view keeps the For me / My team switch.
  await s.page.getByTestId('today-hero').waitFor();
  await go(s, '/?view=team');
  await waitFor(async () => await s.page.getByRole('tab', { name: 'My team', exact: true }).getAttribute('aria-selected') === 'true', 'My team is selected');
  await s.page.getByRole('tab', { name: 'For me', exact: true }).click();
  await s.page.getByTestId('today-hero').waitFor();
  for (const path of ['/work', '/work/projects', '/work/projects?view=portfolio', '/insights', '/people', '/people/teams', '/settings/profile', '/library', '/meetings']) {
    await go(s, path);
    if (path === '/settings/profile') await s.page.locator('main').getByRole('heading', { name: /^Your profile\./ }).waitFor();
    else await s.page.locator('main').getByRole('heading', { level: 1 }).first().waitFor();
    assert.equal(await s.page.getByText('Something went wrong', { exact: true }).count(), 0, path + ' has no crash screen');
    assert.equal(await s.page.getByText('Page not found', { exact: true }).count(), 0, path + ' resolves');
    assert.ok(await s.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), path + ' fits');
  }
  // The Create button (bottom right) replaces the retired Aura create chips; New project opens the project form.
  await go(s, '/work/projects');
  await s.page.getByRole('button', { name: 'Create', exact: true }).click();
  await s.page.getByRole('menu', { name: 'Create', exact: true }).getByRole('menuitem', { name: /New project/ }).click();
  const project = s.page.getByRole('dialog', { name: 'New project', exact: true });
  await project.locator('input').first().waitFor();
  await project.locator('input').first().fill('Smoke form validation');
  assert.ok(await project.getByRole('button', { name: /Cancel/ }).isVisible(), 'The project form has a safe way back');
  await project.getByRole('button', { name: /Cancel/ }).click();
  await s.page.getByRole('button', { name: /^Account:/ }).first().click() // the sidebar row and the header avatar both open it;
  await s.page.getByRole('menu', { name: 'Account', exact: true }).waitFor();
  await s.page.getByRole('menuitem', { name: /Settings/ }).waitFor();
  console.log('PASS Home/team selection, nine main places, layout, Create project and account navigation');
} finally { await s.finish(); }
