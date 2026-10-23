using System;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ProjectManagement.Infrastructure.Persistence.Migrations
{
    /// <summary>
    /// The team password vault: collections with an access list, items whose secrets are encrypted under their own key (wrapped by the
    /// workspace data key), the last ten earlier values, and small encrypted files. Plus three workspace vault rules. Additive only.
    /// </summary>
    [DbContext(typeof(AppDbContext))]
    [Migration("20261106001600_PasswordVault")]
    public partial class PasswordVault : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<bool>(name: "VaultStepUpAlways", table: "TenantSecuritySettings", type: "boolean", nullable: false, defaultValue: false);
            migrationBuilder.AddColumn<int>(name: "VaultClipboardSeconds", table: "TenantSecuritySettings", type: "integer", nullable: false, defaultValue: 30);
            migrationBuilder.AddColumn<bool>(name: "VaultSharedAdminsOnly", table: "TenantSecuritySettings", type: "boolean", nullable: false, defaultValue: false);

            migrationBuilder.CreateTable(
                name: "VaultCollections",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    Name = table.Column<string>(type: "character varying(80)", maxLength: 80, nullable: false),
                    Description = table.Column<string>(type: "character varying(300)", maxLength: 300, nullable: true),
                    Kind = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    OwnerUserId = table.Column<Guid>(type: "uuid", nullable: true),
                    ProjectId = table.Column<Guid>(type: "uuid", nullable: true),
                    TeamId = table.Column<Guid>(type: "uuid", nullable: true),
                    RequireStepUp = table.Column<bool>(type: "boolean", nullable: false),
                    RotateEveryDays = table.Column<int>(type: "integer", nullable: true),
                    LockedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    ArchivedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    Sealed = table.Column<bool>(type: "boolean", nullable: false),
                    SealedKeyVersion = table.Column<int>(type: "integer", nullable: false),
                    RekeyNeeded = table.Column<bool>(type: "boolean", nullable: false),
                    RequireApproval = table.Column<bool>(type: "boolean", nullable: false),
                    Requestable = table.Column<bool>(type: "boolean", nullable: false),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_VaultCollections", x => x.Id);
                });
            migrationBuilder.CreateIndex(name: "IX_VaultCollections_TenantId_Kind_OwnerUserId", table: "VaultCollections", columns: new[] { "TenantId", "Kind", "OwnerUserId" });
            migrationBuilder.CreateIndex(name: "IX_VaultCollections_TenantId_ProjectId", table: "VaultCollections", columns: new[] { "TenantId", "ProjectId" });
            migrationBuilder.CreateIndex(name: "IX_VaultCollections_TenantId_TeamId", table: "VaultCollections", columns: new[] { "TenantId", "TeamId" });

            migrationBuilder.CreateTable(
                name: "VaultShares",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    CollectionId = table.Column<Guid>(type: "uuid", nullable: false),
                    PrincipalType = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    PrincipalId = table.Column<Guid>(type: "uuid", nullable: true),
                    Role = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: true),
                    Access = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    ExpiresAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_VaultShares", x => x.Id);
                    table.ForeignKey(name: "FK_VaultShares_VaultCollections_CollectionId", column: x => x.CollectionId, principalTable: "VaultCollections", principalColumn: "Id", onDelete: ReferentialAction.Cascade);
                });
            migrationBuilder.CreateIndex(name: "IX_VaultShares_CollectionId", table: "VaultShares", column: "CollectionId");
            migrationBuilder.CreateIndex(name: "IX_VaultShares_TenantId_CollectionId", table: "VaultShares", columns: new[] { "TenantId", "CollectionId" });
            migrationBuilder.CreateIndex(name: "IX_VaultShares_TenantId_PrincipalType_PrincipalId", table: "VaultShares", columns: new[] { "TenantId", "PrincipalType", "PrincipalId" });

            migrationBuilder.CreateTable(
                name: "VaultItems",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    CollectionId = table.Column<Guid>(type: "uuid", nullable: false),
                    Kind = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    Title = table.Column<string>(type: "character varying(120)", maxLength: 120, nullable: false),
                    Url = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: true),
                    UsernameHint = table.Column<string>(type: "character varying(80)", maxLength: 80, nullable: true),
                    Tags = table.Column<string>(type: "character varying(400)", maxLength: 400, nullable: true),
                    Class = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    UseOnly = table.Column<bool>(type: "boolean", nullable: false),
                    OwnerUserId = table.Column<Guid>(type: "uuid", nullable: true),
                    FieldsJson = table.Column<string>(type: "character varying(8000)", maxLength: 8000, nullable: false),
                    Cipher = table.Column<string>(type: "text", nullable: false),
                    WrappedItemKey = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: false),
                    KeyVersion = table.Column<int>(type: "integer", nullable: false),
                    HasTotp = table.Column<bool>(type: "boolean", nullable: false),
                    PasswordFingerprint = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: true),
                    Strength = table.Column<int>(type: "integer", nullable: true),
                    BreachCount = table.Column<int>(type: "integer", nullable: true),
                    BreachCheckedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    RotateEveryDays = table.Column<int>(type: "integer", nullable: true),
                    ExpiresAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    ExpiryNotifiedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    ValueChangedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    LastUsedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    LastUsedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    RotationReason = table.Column<string>(type: "character varying(300)", maxLength: 300, nullable: true),
                    LinksJson = table.Column<string>(type: "character varying(4000)", maxLength: 4000, nullable: false),
                    DeletedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    DeletedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    Sealed = table.Column<bool>(type: "boolean", nullable: false),
                    Decoy = table.Column<bool>(type: "boolean", nullable: false),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_VaultItems", x => x.Id);
                    table.ForeignKey(name: "FK_VaultItems_VaultCollections_CollectionId", column: x => x.CollectionId, principalTable: "VaultCollections", principalColumn: "Id", onDelete: ReferentialAction.Cascade);
                });
            migrationBuilder.CreateIndex(name: "IX_VaultItems_CollectionId", table: "VaultItems", column: "CollectionId");
            migrationBuilder.CreateIndex(name: "IX_VaultItems_TenantId_BreachCheckedAt", table: "VaultItems", columns: new[] { "TenantId", "BreachCheckedAt" });
            migrationBuilder.CreateIndex(name: "IX_VaultItems_TenantId_CollectionId_DeletedAt", table: "VaultItems", columns: new[] { "TenantId", "CollectionId", "DeletedAt" });
            migrationBuilder.CreateIndex(name: "IX_VaultItems_TenantId_ExpiresAt", table: "VaultItems", columns: new[] { "TenantId", "ExpiresAt" });
            migrationBuilder.CreateIndex(name: "IX_VaultItems_TenantId_KeyVersion", table: "VaultItems", columns: new[] { "TenantId", "KeyVersion" });
            migrationBuilder.CreateIndex(name: "IX_VaultItems_TenantId_PasswordFingerprint", table: "VaultItems", columns: new[] { "TenantId", "PasswordFingerprint" });

            migrationBuilder.CreateTable(
                name: "VaultItemVersions",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    ItemId = table.Column<Guid>(type: "uuid", nullable: false),
                    Cipher = table.Column<string>(type: "text", nullable: false),
                    WrappedItemKey = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: false),
                    KeyVersion = table.Column<int>(type: "integer", nullable: false),
                    Reason = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: true),
                    Sealed = table.Column<bool>(type: "boolean", nullable: false),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_VaultItemVersions", x => x.Id);
                    table.ForeignKey(name: "FK_VaultItemVersions_VaultItems_ItemId", column: x => x.ItemId, principalTable: "VaultItems", principalColumn: "Id", onDelete: ReferentialAction.Cascade);
                });
            migrationBuilder.CreateIndex(name: "IX_VaultItemVersions_ItemId", table: "VaultItemVersions", column: "ItemId");
            migrationBuilder.CreateIndex(name: "IX_VaultItemVersions_TenantId_ItemId_CreatedAt", table: "VaultItemVersions", columns: new[] { "TenantId", "ItemId", "CreatedAt" });
            migrationBuilder.CreateIndex(name: "IX_VaultItemVersions_TenantId_KeyVersion", table: "VaultItemVersions", columns: new[] { "TenantId", "KeyVersion" });

            migrationBuilder.CreateTable(
                name: "VaultAttachments",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    ItemId = table.Column<Guid>(type: "uuid", nullable: false),
                    FileName = table.Column<string>(type: "character varying(120)", maxLength: 120, nullable: false),
                    ContentType = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: false),
                    SizeBytes = table.Column<long>(type: "bigint", nullable: false),
                    Cipher = table.Column<byte[]>(type: "bytea", nullable: false),
                    WrappedItemKey = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: false),
                    KeyVersion = table.Column<int>(type: "integer", nullable: false),
                    Sealed = table.Column<bool>(type: "boolean", nullable: false),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_VaultAttachments", x => x.Id);
                    table.ForeignKey(name: "FK_VaultAttachments_VaultItems_ItemId", column: x => x.ItemId, principalTable: "VaultItems", principalColumn: "Id", onDelete: ReferentialAction.Cascade);
                });
            migrationBuilder.CreateIndex(name: "IX_VaultAttachments_ItemId", table: "VaultAttachments", column: "ItemId");
            migrationBuilder.CreateIndex(name: "IX_VaultAttachments_TenantId_ItemId", table: "VaultAttachments", columns: new[] { "TenantId", "ItemId" });
            migrationBuilder.CreateIndex(name: "IX_VaultAttachments_TenantId_KeyVersion", table: "VaultAttachments", columns: new[] { "TenantId", "KeyVersion" });

            migrationBuilder.CreateTable(
                name: "VaultIdentities",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    UserId = table.Column<Guid>(type: "uuid", nullable: false),
                    X25519Public = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    MlKemPublic = table.Column<string>(type: "character varying(2000)", maxLength: 2000, nullable: false),
                    Ed25519Public = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    SelfSignature = table.Column<string>(type: "character varying(120)", maxLength: 120, nullable: false),
                    Fingerprint = table.Column<string>(type: "character varying(80)", maxLength: 80, nullable: false),
                    Generation = table.Column<int>(type: "integer", nullable: false),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_VaultIdentities", x => x.Id);
                });
            migrationBuilder.CreateIndex(name: "IX_VaultIdentities_TenantId_UserId", table: "VaultIdentities", columns: new[] { "TenantId", "UserId" }, unique: true);

            migrationBuilder.CreateTable(
                name: "VaultUnlocks",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    UserId = table.Column<Guid>(type: "uuid", nullable: false),
                    Kind = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    Label = table.Column<string>(type: "character varying(80)", maxLength: 80, nullable: false),
                    CredentialId = table.Column<string>(type: "character varying(1400)", maxLength: 1400, nullable: true),
                    Salt = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: false),
                    Params = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: false),
                    WrappedSeed = table.Column<string>(type: "character varying(400)", maxLength: 400, nullable: false),
                    LastUsedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_VaultUnlocks", x => x.Id);
                });
            migrationBuilder.CreateIndex(name: "IX_VaultUnlocks_TenantId_UserId", table: "VaultUnlocks", columns: new[] { "TenantId", "UserId" });

            migrationBuilder.CreateTable(
                name: "VaultKeyEnvelopes",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    CollectionId = table.Column<Guid>(type: "uuid", nullable: false),
                    KeyVersion = table.Column<int>(type: "integer", nullable: false),
                    RecipientUserId = table.Column<Guid>(type: "uuid", nullable: false),
                    RecipientGeneration = table.Column<int>(type: "integer", nullable: false),
                    SenderUserId = table.Column<Guid>(type: "uuid", nullable: false),
                    Envelope = table.Column<string>(type: "character varying(4000)", maxLength: 4000, nullable: false),
                    Signature = table.Column<string>(type: "character varying(120)", maxLength: 120, nullable: false),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_VaultKeyEnvelopes", x => x.Id);
                    table.ForeignKey(name: "FK_VaultKeyEnvelopes_VaultCollections_CollectionId", column: x => x.CollectionId, principalTable: "VaultCollections", principalColumn: "Id", onDelete: ReferentialAction.Cascade);
                });
            migrationBuilder.CreateIndex(name: "IX_VaultKeyEnvelopes_CollectionId", table: "VaultKeyEnvelopes", column: "CollectionId");
            migrationBuilder.CreateIndex(name: "IX_VaultKeyEnvelopes_TenantId_CollectionId_KeyVersion", table: "VaultKeyEnvelopes", columns: new[] { "TenantId", "CollectionId", "KeyVersion" });
            migrationBuilder.CreateIndex(name: "IX_VaultKeyEnvelopes_TenantId_RecipientUserId", table: "VaultKeyEnvelopes", columns: new[] { "TenantId", "RecipientUserId" });

            migrationBuilder.CreateTable(
                name: "VaultDeviceLinks",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    UserId = table.Column<Guid>(type: "uuid", nullable: false),
                    Label = table.Column<string>(type: "character varying(80)", maxLength: 80, nullable: false),
                    X25519Public = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    MlKemPublic = table.Column<string>(type: "character varying(2000)", maxLength: 2000, nullable: false),
                    Envelope = table.Column<string>(type: "character varying(4000)", maxLength: 4000, nullable: true),
                    Signature = table.Column<string>(type: "character varying(120)", maxLength: 120, nullable: true),
                    ExpiresAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    ApprovedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    CompletedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    Denied = table.Column<bool>(type: "boolean", nullable: false),
                    IpAddress = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: true),
                    UserAgent = table.Column<string>(type: "character varying(300)", maxLength: 300, nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_VaultDeviceLinks", x => x.Id);
                });
            migrationBuilder.CreateIndex(name: "IX_VaultDeviceLinks_TenantId_UserId_ExpiresAt", table: "VaultDeviceLinks", columns: new[] { "TenantId", "UserId", "ExpiresAt" });

            migrationBuilder.CreateTable(
                name: "VaultAccessRequests",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    Kind = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    CollectionId = table.Column<Guid>(type: "uuid", nullable: false),
                    ItemId = table.Column<Guid>(type: "uuid", nullable: true),
                    RequesterId = table.Column<Guid>(type: "uuid", nullable: false),
                    Reason = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: false),
                    Access = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    Minutes = table.Column<int>(type: "integer", nullable: false),
                    Status = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    DecidedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    DecidedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    DecisionNote = table.Column<string>(type: "character varying(300)", maxLength: 300, nullable: true),
                    GrantedUntil = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_VaultAccessRequests", x => x.Id);
                });
            migrationBuilder.CreateIndex(name: "IX_VaultAccessRequests_TenantId_CollectionId_Status", table: "VaultAccessRequests", columns: new[] { "TenantId", "CollectionId", "Status" });
            migrationBuilder.CreateIndex(name: "IX_VaultAccessRequests_TenantId_RequesterId_Status", table: "VaultAccessRequests", columns: new[] { "TenantId", "RequesterId", "Status" });
            migrationBuilder.CreateIndex(name: "IX_VaultAccessRequests_TenantId_ItemId_RequesterId", table: "VaultAccessRequests", columns: new[] { "TenantId", "ItemId", "RequesterId" });

            migrationBuilder.CreateTable(
                name: "VaultRecoveryShares",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    UserId = table.Column<Guid>(type: "uuid", nullable: false),
                    TrusteeUserId = table.Column<Guid>(type: "uuid", nullable: false),
                    Threshold = table.Column<int>(type: "integer", nullable: false),
                    Generation = table.Column<int>(type: "integer", nullable: false),
                    TrusteeGeneration = table.Column<int>(type: "integer", nullable: false),
                    Envelope = table.Column<string>(type: "character varying(4000)", maxLength: 4000, nullable: false),
                    Signature = table.Column<string>(type: "character varying(120)", maxLength: 120, nullable: false),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_VaultRecoveryShares", x => x.Id);
                });
            migrationBuilder.CreateIndex(name: "IX_VaultRecoveryShares_TenantId_UserId", table: "VaultRecoveryShares", columns: new[] { "TenantId", "UserId" });
            migrationBuilder.CreateIndex(name: "IX_VaultRecoveryShares_TenantId_TrusteeUserId", table: "VaultRecoveryShares", columns: new[] { "TenantId", "TrusteeUserId" });

            migrationBuilder.CreateTable(
                name: "VaultRecoveryRequests",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    UserId = table.Column<Guid>(type: "uuid", nullable: false),
                    X25519Public = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    MlKemPublic = table.Column<string>(type: "character varying(2000)", maxLength: 2000, nullable: false),
                    ExpiresAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CompletedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    Cancelled = table.Column<bool>(type: "boolean", nullable: false),
                    IpAddress = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: true),
                    UserAgent = table.Column<string>(type: "character varying(300)", maxLength: 300, nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_VaultRecoveryRequests", x => x.Id);
                });
            migrationBuilder.CreateIndex(name: "IX_VaultRecoveryRequests_TenantId_UserId_ExpiresAt", table: "VaultRecoveryRequests", columns: new[] { "TenantId", "UserId", "ExpiresAt" });

            migrationBuilder.CreateTable(
                name: "VaultRecoveryReleases",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    RequestId = table.Column<Guid>(type: "uuid", nullable: false),
                    TrusteeUserId = table.Column<Guid>(type: "uuid", nullable: false),
                    Envelope = table.Column<string>(type: "character varying(4000)", maxLength: 4000, nullable: true),
                    Signature = table.Column<string>(type: "character varying(120)", maxLength: 120, nullable: true),
                    Refused = table.Column<bool>(type: "boolean", nullable: false),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_VaultRecoveryReleases", x => x.Id);
                });
            migrationBuilder.CreateIndex(name: "IX_VaultRecoveryReleases_TenantId_RequestId", table: "VaultRecoveryReleases", columns: new[] { "TenantId", "RequestId" });

            migrationBuilder.CreateTable(
                name: "VaultSecretLinks",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    TokenHash = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    ItemId = table.Column<Guid>(type: "uuid", nullable: true),
                    Note = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: true),
                    Cipher = table.Column<string>(type: "character varying(140000)", maxLength: 140000, nullable: false),
                    HasPassphrase = table.Column<bool>(type: "boolean", nullable: false),
                    Salt = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: true),
                    Params = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: true),
                    MaxViews = table.Column<int>(type: "integer", nullable: false),
                    Views = table.Column<int>(type: "integer", nullable: false),
                    ExpiresAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    BurnedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    RevokedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    LastOpenedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    LastOpenedIp = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_VaultSecretLinks", x => x.Id);
                });
            migrationBuilder.CreateIndex(name: "IX_VaultSecretLinks_TokenHash", table: "VaultSecretLinks", column: "TokenHash", unique: true);
            migrationBuilder.CreateIndex(name: "IX_VaultSecretLinks_TenantId_CreatedBy_CreatedAt", table: "VaultSecretLinks", columns: new[] { "TenantId", "CreatedBy", "CreatedAt" });
            migrationBuilder.CreateIndex(name: "IX_VaultSecretLinks_ExpiresAt", table: "VaultSecretLinks", column: "ExpiresAt");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(name: "VaultSecretLinks");
            migrationBuilder.DropTable(name: "VaultRecoveryReleases");
            migrationBuilder.DropTable(name: "VaultRecoveryRequests");
            migrationBuilder.DropTable(name: "VaultRecoveryShares");
            migrationBuilder.DropTable(name: "VaultAccessRequests");
            migrationBuilder.DropTable(name: "VaultDeviceLinks");
            migrationBuilder.DropTable(name: "VaultKeyEnvelopes");
            migrationBuilder.DropTable(name: "VaultUnlocks");
            migrationBuilder.DropTable(name: "VaultIdentities");
            migrationBuilder.DropTable(name: "VaultAttachments");
            migrationBuilder.DropTable(name: "VaultItemVersions");
            migrationBuilder.DropTable(name: "VaultItems");
            migrationBuilder.DropTable(name: "VaultShares");
            migrationBuilder.DropTable(name: "VaultCollections");
            migrationBuilder.DropColumn(name: "VaultStepUpAlways", table: "TenantSecuritySettings");
            migrationBuilder.DropColumn(name: "VaultClipboardSeconds", table: "TenantSecuritySettings");
            migrationBuilder.DropColumn(name: "VaultSharedAdminsOnly", table: "TenantSecuritySettings");
        }
    }
}
