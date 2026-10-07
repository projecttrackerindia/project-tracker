using ProjectManagement.Application.Features.ApiDocs;

namespace ProjectManagement.Tests;

public class ApiCurlTests
{
    [Fact]
    public void A_command_becomes_an_endpoint_and_credentials_are_dropped()
    {
        var text = """
            # create an order
            curl -X POST 'https://api.shop.test/v1/orders?expand=items&api_key=SECRET1' \
              -H 'Authorization: Bearer SECRET2' \
              -H "Content-Type: application/json" \
              -d '{"sku":"A1","qty":2}' -u me:SECRET3

            curl https://api.shop.test/v1/orders/{id}
            """;
        Assert.True(ApiCurl.Looks(text));
        var r = ApiCurl.Import(text, "x");
        var api = r.Api!;
        Assert.Equal(2, api.Endpoints.Count);
        Assert.Equal(["https://api.shop.test"], api.Servers);
        var post = api.Endpoints[0];
        Assert.Equal("POST", post.Method); Assert.Equal("/v1/orders", post.Path);
        Assert.Equal("application/json", post.Details.RequestBody!.ContentType);
        Assert.Contains("\"sku\"", post.Details.RequestBody.Example);
        Assert.Contains(post.Details.Parameters, p => p.In == "query" && p.Name == "expand" && p.Example == "items");
        Assert.Contains(post.Details.Parameters, p => p.In == "query" && p.Name == "api_key" && p.Example is null);
        Assert.Contains(post.Details.Parameters, p => p.In == "header" && p.Name == "Authorization" && p.Example is null);
        Assert.DoesNotContain("SECRET", ApiJson.Write(post.Details));
        Assert.Contains(r.Issues, i => i.Message.Contains("Credentials"));
        var get = api.Endpoints[1];
        Assert.Equal("GET", get.Method); Assert.Contains(get.Details.Parameters, p => p.In == "path" && p.Name == "id");
    }

    [Fact]
    public void Nothing_usable_is_reported_and_other_files_are_not_mistaken_for_curl()
    {
        Assert.False(ApiCurl.Looks("{\"openapi\":\"3.0.0\"}"));
        var r = ApiCurl.Import("curl -s", "x");
        Assert.Null(r.Api); Assert.Contains(r.Issues, i => i.Severity == "error");
    }
}
