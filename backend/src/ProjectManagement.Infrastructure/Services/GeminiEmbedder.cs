using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Features.Ai;

namespace ProjectManagement.Infrastructure.Services;

/// <summary>
/// Meaning vectors from Google: on Vertex AI (signed in as the server, served in the configured region, e.g. Mumbai) with the multilingual
/// embedding model, or with the Gemini API and a key. Pages are embedded as "documents" and questions as "queries", which is what these
/// models are trained for. No conversation content is sent here, only the indexed text and the search question.
/// </summary>
public sealed class GeminiEmbedder(IHttpClientFactory http, IOptions<AiOptions> options, GoogleAccessToken? token = null) : IAiEmbedder
{
    private AiGeminiOptions G => options.Value.Gemini;
    public bool Configured => options.Value.UsesGemini && !string.IsNullOrWhiteSpace(G.EmbeddingModel) && (G.Vertex ? token is not null : !string.IsNullOrWhiteSpace(G.ApiKey));

    /// <summary>The model actually used: the multilingual Vertex model has a Gemini API counterpart with a different name.</summary>
    public string Model => G.Vertex || !(G.EmbeddingModel ?? "").StartsWith("text-multilingual", StringComparison.Ordinal) ? G.EmbeddingModel ?? "" : "gemini-embedding-001";

    public async Task<IReadOnlyList<float[]>> EmbedAsync(IReadOnlyList<string> texts, bool query, CancellationToken ct)
    {
        if (!Configured || texts.Count == 0) return [];
        var task = query ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT";
        var dims = Math.Clamp(G.EmbeddingDimensions, 64, 768);
        HttpRequestMessage req;
        if (G.Vertex)
        {
            var host = G.Location == "global" ? "aiplatform.googleapis.com" : $"{G.Location}-aiplatform.googleapis.com";
            var url = $"https://{host}/v1/projects/{Uri.EscapeDataString(G.ProjectId)}/locations/{G.Location}/publishers/google/models/{Uri.EscapeDataString(Model)}:predict";
            var body = new JsonObject
            {
                ["instances"] = new JsonArray(texts.Select(t => (JsonNode)new JsonObject { ["content"] = t, ["task_type"] = task }).ToArray()),
                ["parameters"] = new JsonObject { ["outputDimensionality"] = dims, ["autoTruncate"] = true },
            };
            req = new HttpRequestMessage(HttpMethod.Post, url) { Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json") };
            req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", await token!.GetAsync(ct));
        }
        else
        {
            var url = $"https://generativelanguage.googleapis.com/v1beta/models/{Uri.EscapeDataString(Model)}:batchEmbedContents";
            var body = new JsonObject
            {
                ["requests"] = new JsonArray(texts.Select(t => (JsonNode)new JsonObject
                {
                    ["model"] = $"models/{Model}", ["taskType"] = task, ["outputDimensionality"] = dims,
                    ["content"] = new JsonObject { ["parts"] = new JsonArray(new JsonObject { ["text"] = t }) },
                }).ToArray()),
            };
            req = new HttpRequestMessage(HttpMethod.Post, url) { Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json") };
            req.Headers.Add("x-goog-api-key", G.ApiKey!.Trim());
        }
        using (req)
        using (var res = await http.CreateClient("ai-embeddings").SendAsync(req, ct))
        {
            if (!res.IsSuccessStatusCode) throw new HttpRequestException($"The embedding model answered {(int)res.StatusCode}.");
            using var doc = JsonDocument.Parse(await res.Content.ReadAsStringAsync(ct));
            var list = new List<float[]>();
            if (G.Vertex)
            {
                foreach (var p in doc.RootElement.GetProperty("predictions").EnumerateArray())
                    list.Add(p.GetProperty("embeddings").GetProperty("values").EnumerateArray().Select(x => x.GetSingle()).ToArray());
            }
            else
            {
                foreach (var e in doc.RootElement.GetProperty("embeddings").EnumerateArray())
                    list.Add(e.GetProperty("values").EnumerateArray().Select(x => x.GetSingle()).ToArray());
            }
            return list;
        }
    }
}
