namespace ProjectManagement.Api.Filters;

/// <summary>
/// The response (or the request) can carry a secret value: a revealed password, a one-time code, a two-step token, an encrypted file's contents.
/// Such endpoints are never stored by the idempotency layer, which would otherwise keep the response in its table and replay it to a retry
/// without the checks and the audit entry a real reveal gets. A repeated request simply runs again, and is checked and audited again.
/// </summary>
[AttributeUsage(AttributeTargets.Class | AttributeTargets.Method)]
public sealed class SecretResponseAttribute : Attribute { }
