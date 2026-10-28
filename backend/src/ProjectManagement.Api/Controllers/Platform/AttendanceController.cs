using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Attendance;

namespace ProjectManagement.Api.Controllers.Platform;

/// <summary>My own check-in / check-out on the organization's clock. See <see cref="AttendanceService"/>.</summary>
[Route("api/v1/me/attendance"), RequireWorkspace]
public class MyAttendanceController(AttendanceService attendance) : ApiControllerBase
{
    /// <summary>Today in the organization's time: the rules, my check-in, and whether the app should ask me to check in now.</summary>
    [HttpGet("today")]
    public async Task<IActionResult> Today(CancellationToken ct) => Ok(await attendance.TodayAsync(ct));

    [HttpPost("check-in")]
    public async Task<IActionResult> CheckIn([FromBody] CheckInRequest req, CancellationToken ct) => Created(await attendance.CheckInAsync(req, ct));

    /// <summary>Closes the open day and returns its summary (hours, work finished, time logged).</summary>
    [HttpPost("check-out")]
    public async Task<IActionResult> CheckOut([FromBody] CheckOutRequest req, CancellationToken ct) => Ok(await attendance.CheckOutAsync(req, ct));

    /// <summary>Correct my own day (today only).</summary>
    [HttpPut("{date}")]
    public async Task<IActionResult> Correct(DateOnly date, [FromBody] CorrectAttendanceRequest req, CancellationToken ct) => Ok(await attendance.CorrectAsync(date, req, ct));
}

/// <summary>Attendance for the calendar and reports (mine, or my team's), who is where today, and the workspace's attendance settings.</summary>
[Route("api/v1/attendance"), RequireWorkspace]
public class AttendanceController(AttendanceService attendance) : ApiControllerBase
{
    /// <summary>Days between two dates; scope=team for the people I manage (everyone for owners and admins).</summary>
    [HttpGet]
    public async Task<IActionResult> List([FromQuery] DateOnly from, [FromQuery] DateOnly to, [FromQuery] string? scope, [FromQuery] Guid? userId, CancellationToken ct) =>
        Ok(await attendance.ListAsync(from, to, scope, userId, ct));

    [HttpGet("team/today")]
    public async Task<IActionResult> TeamToday(CancellationToken ct) => Ok(await attendance.TeamTodayAsync(ct));

    [HttpGet("settings")]
    public async Task<IActionResult> Settings(CancellationToken ct) => Ok(await attendance.GetPolicyAsync(ct));

    [HttpPut("settings")]
    public async Task<IActionResult> SaveSettings([FromBody] SaveAttendancePolicyRequest req, CancellationToken ct) => Ok(await attendance.SavePolicyAsync(req, ct));
}
