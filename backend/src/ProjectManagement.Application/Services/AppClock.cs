using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Services;

/// <summary>UTC "now" plus a deterministic local "today" (date-only fields are day-based, not instants).</summary>
public class AppClock(TimeProvider time, IOptions<AppOptions> options)
{
    public DateTime Now => time.GetUtcNow().UtcDateTime;
    public int OffsetMinutes => options.Value.TimeZoneOffsetMinutes;
    public DateOnly Today => DateOnly.FromDateTime(Now.AddMinutes(OffsetMinutes));
}
