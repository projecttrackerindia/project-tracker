namespace ProjectManagement.Application.Features.Resumes;

/// <summary>
/// Twelve curated designs that differ in layout, not only in colour: seven single-column (centred or left-aligned name, with or without
/// rules, generous or compact margins) and five with a coloured banner and a sidebar. Colours are chosen to print well and to read in
/// greyscale. Files already bought are kept as they were made; a design no longer in the list cannot be chosen for new exports.
/// </summary>
internal static class ResumeTemplateCatalog
{
    internal static readonly ResumeTemplate[] Templates = [
        //  id  name                 description                                              accent   margin centered rule heading twoColumn header   text     heading  role                              banner accent
        new(1,  "Classic",           "Centred name and thin rules. Fits any role.",           "1F2937", 54, true,  true,  12, false, "1F2937", "FFFFFF", "1F2937", "Any role",                        "FFFFFF"),
        new(2,  "Modern",            "Left-aligned, blue rules, generous spacing.",           "1D4ED8", 50, false, true,  12, false, "1D4ED8", "FFFFFF", "1D4ED8", "Product and business",            "FFFFFF"),
        new(3,  "Minimal",           "No lines: type and white space only.",                  "111827", 60, false, false, 11, false, "111827", "FFFFFF", "111827", "Design and writing",              "FFFFFF"),
        new(4,  "Executive",         "Centred, navy, larger headings for leadership roles.",  "1E3A5F", 60, true,  true,  13, false, "1E3A5F", "FFFFFF", "1E3A5F", "Leadership",                      "FFFFFF"),
        new(5,  "Compact",           "Tight margins and smaller headings: more on one page.", "0F766E", 30, false, true,  10, false, "0F766E", "FFFFFF", "0F766E", "Experienced professionals",       "FFFFFF"),
        new(6,  "Academic",          "Centred and quiet, burgundy headings.",                 "7F1D1D", 58, true,  false, 12, false, "7F1D1D", "FFFFFF", "7F1D1D", "Research and teaching",           "FFFFFF"),
        new(7,  "Technical",         "Slate rules, compact headings for engineering roles.",  "334155", 42, false, true,  11, false, "334155", "FFFFFF", "334155", "Engineering",                     "FFFFFF"),
        new(8,  "Sidebar Navy",      "Navy banner, skills and education in a sidebar.",       "38BDF8", 36, true,  true,  11, true,  "0F172A", "FFFFFF", "1E3A8A", "Technology",                      "7DD3FC"),
        new(9,  "Sidebar Forest",    "Deep green banner with a sidebar.",                     "4ADE80", 36, true,  true,  11, true,  "14532D", "FFFFFF", "166534", "Operations",                      "86EFAC"),
        new(10, "Sidebar Plum",      "Plum banner with a sidebar.",                           "C084FC", 36, true,  true,  11, true,  "3B0764", "FFFFFF", "6B21A8", "Creative roles",                  "D8B4FE"),
        new(11, "Sidebar Light",     "Light banner, blue headings, with a sidebar.",          "2563EB", 36, true,  true,  11, true,  "F1F5F9", "0F172A", "1D4ED8", "Consulting and analysis",         "2563EB"),
        new(12, "Sidebar Terracotta","Warm terracotta banner with a sidebar.",                "FB923C", 36, true,  true,  11, true,  "7C2D12", "FFFFFF", "9A3412", "Sales and marketing",             "FDBA74"),
    ];
}
