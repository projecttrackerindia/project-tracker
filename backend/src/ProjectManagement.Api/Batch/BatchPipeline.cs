namespace ProjectManagement.Api.Batch;

/// <summary>
/// The app's own request pipeline, from routing onwards, so a batched read is answered by exactly the same code as a direct call to it:
/// the same route, the same controller, and above all the same authorization filters. Set once at start-up (Program.cs) because the
/// endpoints are only known there.
/// </summary>
public sealed class BatchPipeline
{
    private RequestDelegate? handler;
    public void Use(RequestDelegate h) => handler = h;
    public RequestDelegate Handler => handler ?? throw new InvalidOperationException("The batch pipeline was not set up.");
    public bool Ready => handler is not null;
}
