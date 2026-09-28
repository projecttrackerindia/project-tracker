# Build context is this (backend) folder:  docker build -t pm-api backend
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src

# Restore first (cached until a .csproj changes)
COPY Directory.Build.props ./
COPY src/ProjectManagement.Domain/*.csproj src/ProjectManagement.Domain/
COPY src/ProjectManagement.Application/*.csproj src/ProjectManagement.Application/
COPY src/ProjectManagement.Infrastructure/*.csproj src/ProjectManagement.Infrastructure/
COPY src/ProjectManagement.Api/*.csproj src/ProjectManagement.Api/
RUN dotnet restore src/ProjectManagement.Api/ProjectManagement.Api.csproj

COPY src/ src/
RUN dotnet publish src/ProjectManagement.Api/ProjectManagement.Api.csproj -c Release -o /app --no-restore

FROM mcr.microsoft.com/dotnet/aspnet:9.0
WORKDIR /app
COPY --from=build /app .
ENV ASPNETCORE_HTTP_PORTS=8080 \
    ASPNETCORE_ENVIRONMENT=Production
RUN mkdir -p /app/data/files && chown -R $APP_UID /app/data
EXPOSE 8080
USER $APP_UID
ENTRYPOINT ["dotnet", "ProjectManagement.Api.dll"]
