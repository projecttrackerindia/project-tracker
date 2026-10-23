import type { VaultMachine } from './api';

/** The workflow lines that read this collection in a GitHub Actions job: the run's own token in, masked environment variables out. */
export function workflowSnippet(m: VaultMachine, origin = window.location.origin) {
  return [
    'permissions:',
    '  id-token: write   # lets the job ask GitHub for its own short-lived identity token',
    '  contents: read',
    '',
    '# in the job' + (m.environment ? ` (it must run in the environment "${m.environment}")` : '') + ':',
    ...(m.environment ? [`    environment: ${m.environment}`] : []),
    '    steps:',
    '      - name: Secrets from the Project Tracker vault',
    '        run: |',
    `          OIDC=$(curl -sSf -H "Authorization: bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=${m.audience}" | jq -r .value)`,
    `          curl -sSf -X POST -H "Authorization: Bearer $OIDC" ${origin}${m.endpoint} > "$RUNNER_TEMP/vault.json"`,
    `          jq -r '.data.variables[].value | split("\\n")[] | select(length > 0) | "::add-mask::" + .' "$RUNNER_TEMP/vault.json"`,
    `          jq -r '.data.variables[] | "\\(.name)<<__PT_VAULT__\\n\\(.value)\\n__PT_VAULT__"' "$RUNNER_TEMP/vault.json" >> "$GITHUB_ENV"`,
    '          rm -f "$RUNNER_TEMP/vault.json"',
  ].join('\n');
}
