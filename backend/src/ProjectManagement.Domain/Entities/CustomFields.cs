using ProjectManagement.Domain.Common;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Domain.Enums
{
    public enum CustomFieldType { Text, Number, Date, Dropdown, Checkbox }
}

namespace ProjectManagement.Domain.Entities
{
    /// <summary>An extra field every task of the workspace can carry (for example "Customer", "Story points" or "Release date").</summary>
    public class CustomFieldDefinition : TenantEntity, ITenantScoped
    {
        public string Name { get; set; } = "";
        public CustomFieldType Type { get; set; }
        /// <summary>Dropdown choices, one per line. Empty for other types.</summary>
        public string? Options { get; set; }
        public int SortOrder { get; set; }
    }

    /// <summary>
    /// The value of one custom field on one task, stored in a canonical text form so every provider treats it alike:
    /// numbers as invariant decimals, dates as yyyy-MM-dd, checkboxes as "true" / "false", dropdowns as the chosen option.
    /// A task with no value for a field simply has no row.
    /// </summary>
    public class CustomFieldValue : TenantEntity, ITenantScoped
    {
        public Guid TaskId { get; set; }
        public Guid FieldId { get; set; }
        public string Value { get; set; } = "";
    }
}
