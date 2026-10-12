namespace ProjectManagement.Api.Filters;

/// <summary>Provider operations commit their own durable receipts before dispatch; generic database retry transactions cannot wrap them.</summary>
[AttributeUsage(AttributeTargets.Method)]
public sealed class ExternalOperationAttribute : Attribute { }
