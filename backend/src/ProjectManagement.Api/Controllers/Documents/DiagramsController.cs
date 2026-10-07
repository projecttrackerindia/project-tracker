using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Documents;
using ProjectManagement.Domain;

namespace ProjectManagement.Api.Controllers.Documents;

/// <summary>A drawing service for diagrams written as text (flowchart subset of Mermaid). It stores nothing and changes nothing: the same drawing is used on screen and in PDFs.</summary>
[Route("api/v1/documents/diagrams"), RequireWorkspace, RequireModule(Modules.Documents)]
public class DiagramsController : ApiControllerBase
{
    [HttpPost("render")]
    public IActionResult Render([FromBody] RenderDiagramRequest req)
    {
        try
        {
            var model = DiagramEngine.Draw(req.Source ?? "");
            return Ok(new { svg = DiagramEngine.ToSvg(model), width = model.Width, height = model.Height, nodes = model.Nodes.Count, edges = model.Edges.Count });
        }
        catch (DiagramException e) { throw new ValidationException("source", e.Line > 0 ? $"Line {e.Line}: {e.Message}" : e.Message); }
    }
}
