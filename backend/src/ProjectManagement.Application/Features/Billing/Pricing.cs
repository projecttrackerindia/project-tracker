namespace ProjectManagement.Application.Features.Billing;

public class VolumeTier
{
    public int MinSeats { get; set; }
    public int Percent { get; set; }
}

/// <summary>Discounts and limits of per-person pricing (<c>Billing:Pricing</c>). The defaults are the published offer.</summary>
public class PricingOptions
{
    public const string Section = "Billing:Pricing";
    /// <summary>Off the monthly price when a year is paid at once.</summary>
    public int AnnualDiscountPercent { get; set; } = 20;
    /// <summary>Automatic discount for larger teams: the highest tier whose MinSeats the workspace reaches.</summary>
    public List<VolumeTier> VolumeTiers { get; set; } = [new() { MinSeats = 10, Percent = 10 }, new() { MinSeats = 25, Percent = 15 }, new() { MinSeats = 100, Percent = 20 }];
    /// <summary>Annual and volume discounts add up to at most this much.</summary>
    public int MaxTotalDiscountPercent { get; set; } = 30;
    public int MaxSeats { get; set; } = 5000;
}

/// <summary>What a choice of plan, people and billing period costs. Computed in one place so the screen, the invoice, the payment provider and the website agree.</summary>
public record PriceQuote(string PlanCode, int Seats, string Period, string Currency, decimal ListPerSeatMonthly, int VolumePercent, int AnnualPercent, int TotalPercent,
    decimal EffectivePerSeatMonthly, decimal ChargePerCycle, int CycleMonths, decimal ListTotalPerCycle, decimal SavedPerCycle, decimal YearlyTotal);

public static class Pricing
{
    public const string Monthly = "monthly", Yearly = "yearly";
    /// <summary>A trial of a paid plan: this many people, and a small pool of AI credits so a trial cannot cost more than it brings in.</summary>
    public const int TrialSeats = 5, TrialAiCredits = 100;

    public static string NormalizePeriod(string? period) => string.Equals(period?.Trim(), Yearly, StringComparison.OrdinalIgnoreCase) ? Yearly : Monthly;
    public static int Months(string period) => period == Yearly ? 12 : 1;

    public static int VolumePercent(PricingOptions o, int seats) => o.VolumeTiers.Where(t => seats >= t.MinSeats).Select(t => t.Percent).DefaultIfEmpty(0).Max();

    /// <summary>The price of <paramref name="seats"/> people on a per-seat plan; for a flat plan the one price (seats are not multiplied).</summary>
    public static PriceQuote Quote(PricingOptions o, string planCode, decimal pricePerSeatMonthly, string currency, bool perSeat, int seats, string? period)
    {
        period = NormalizePeriod(period);
        seats = perSeat ? Math.Clamp(seats, 1, o.MaxSeats) : 1;
        var volume = perSeat ? VolumePercent(o, seats) : 0;
        var annual = period == Yearly ? o.AnnualDiscountPercent : 0;
        var total = Math.Min(o.MaxTotalDiscountPercent, volume + annual);
        var months = Months(period);
        var list = pricePerSeatMonthly * seats * months;
        // A discounted total is rounded to a whole unit (3,350, not 3,350.40); an undiscounted one is exact.
        var charge = total == 0 ? Math.Round(list, 2, MidpointRounding.AwayFromZero) : Math.Round(list * (100 - total) / 100m, 0, MidpointRounding.AwayFromZero);
        var effective = seats == 0 ? 0 : Math.Round(charge / months / seats, 2, MidpointRounding.AwayFromZero);
        return new PriceQuote(planCode, seats, period, currency, pricePerSeatMonthly, volume, annual, total, effective, charge, months, list, list - charge,
            period == Yearly ? charge : Math.Round(pricePerSeatMonthly * seats * 12 * (100 - Math.Min(o.MaxTotalDiscountPercent, volume)) / 100m, 0, MidpointRounding.AwayFromZero));
    }
}
