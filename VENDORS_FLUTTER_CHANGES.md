# Vendor accounts — Flutter change request #1: names and assigned-to filters

**Audience:** the Flutter agent working on the NycPay app (`lib/vendor/*`, `lib/VendorService.dart`,
`lib/models/VendorModels.dart`).
**Spec:** [`VENDORS_FLUTTER_UI.md`](VENDORS_FLUTTER_UI.md) §5.1, §6 row 5, §9.5, §10. This file lists the exact
edits against the code as it is now.

## Why

The vendor screens were built from the first version of the guide. Since then the API gained two things
the app doesn't use yet:

1. **Names on every account.** Each account the API returns now carries `vendorName`, `managerName`
   (subadmin) and `assignedUserName` (merchant), resolved server-side, next to the existing
   `accountHolderName`. Today the app shows no vendor at all on the account list, and resolves
   merchant/subadmin names from `VendorNames.loadUsers()`, which falls back to raw ids when a user isn't in the
   one page it loads.
2. **Assigned-to filters on `GET /api/vendors/accounts`:** `managedByUserId` (admin) and `assignedUserId`
   (admin + subadmin), each accepting `none` = unassigned, alongside the existing `vendorId` (admin). The
   list currently filters only by state, mode and type.

## Before you start

- **Replace the doc copies at the NycPay repo root** (`VENDORS_FLUTTER_UI.md`, `VENDORS_FRONTEND.md`) with
  the current ones from the API repo. The root copies predate this change.
- **The API must be deployed** with this change. On an older server the three name fields are absent
  (your code falls back, see below) and unknown query params are **ignored**, so the filters would silently
  return every account. To check: `GET /api/vendors/accounts?limit=1` as admin must include `"vendorName"`
  in the account object.

## What the server sends, per role

| Field | admin | vendor | subadmin | merchant |
|---|---|---|---|---|
| `accountHolderName` (name on the bank account) | ✓ | ✓ | ✓ | ✓ |
| `vendorName` | ✓ | ✓ | — | — |
| `managerName` (subadmin) | ✓ | — | ✓ | ✓ |
| `assignedUserName` (merchant) | ✓ | — | ✓ | ✓ |

"—" means the key is **absent** from the JSON. `null` means unassigned: show **Unassigned**. Each name is
users_meta `name`, falling back to email.

| Filter param | admin | subadmin | others |
|---|---|---|---|
| `vendorId=<id>` | ✓ | ignored | ignored |
| `managedByUserId=<id>` or `none` | ✓ | ignored | ignored |
| `assignedUserId=<id>` or `none` | ✓ | ✓ (own merchants) | ignored |

Filters stack. A malformed id returns `400 Invalid <param>`.

---

## Change 1: `lib/models/VendorModels.dart` → `class VendorAccount`

Add three nullable fields next to `vendorId, assignedUserId, managedByUserId`, then add them to the
constructor and `fromJson`:

```dart
  final String? vendorId, assignedUserId, managedByUserId;
  // Server-resolved display names for the ids above (null = unassigned). Same
  // visibility as the ids: vendor gets vendorName only; subadmin/merchant never do.
  final String? vendorName, managerName, assignedUserName;
```

```dart
    this.managedByUserId,
    this.vendorName,
    this.managerName,
    this.assignedUserName,
```

```dart
        managedByUserId: _str(j['managedByUserId']),
        vendorName: _str(j['vendorName']),
        managerName: _str(j['managerName']),
        assignedUserName: _str(j['assignedUserName']),
```

## Change 2: `lib/VendorService.dart` → `accounts(...)`

Add two optional params and send them (`_uri` already drops null/empty values):

```dart
  static Future<VendorPage<VendorAccount>> accounts({
    String? state,
    String? mode,
    String? accountType,
    String? vendorId, // admin
    String? managedByUserId, // admin; 'none' = no subadmin
    String? assignedUserId, // admin + subadmin; 'none' = no merchant
    String? cursor,
    int limit = 25,
  }) async =>
      _page(
        await _call('GET', '/accounts', query: {
          'state': state,
          'mode': mode,
          'accountType': accountType,
          'vendorId': vendorId,
          'managedByUserId': managedByUserId,
          'assignedUserId': assignedUserId,
          'cursor': cursor,
          'limit': '$limit',
        }),
        'accounts',
        VendorAccount.fromJson,
      );
```

`allAccounts(...)` can stay as it is.

## Change 3: `lib/vendor/vendor_widgets.dart` → `class VendorNames`

Add one helper: prefer the server's name, fall back to the local user list, then the id.

```dart
  /// Prefer the name the server sent on the account (vendorName / managerName /
  /// assignedUserName); fall back to the local user list, then the raw id.
  String nameOr(String? serverName, String? id, {String empty = '—'}) =>
      (serverName ?? '').isNotEmpty ? serverName! : userName(id, empty: empty);
```

## Change 4: `lib/vendor/vendor_widgets.dart` → `VendorAccountCard.build`

Replace the existing admin/subadmin line (`'Merchant ${names!.userName(...)} · Subadmin …'`, near the end of
the card) with a "who" row that also shows the **vendor** for admin. It must render even when `names` is
null, because the server names alone are enough:

```dart
          if (viewer == VendorViewer.admin || viewer == VendorViewer.subadmin) ...[
            const SizedBox(height: Sp.xs),
            Wrap(spacing: Sp.md, runSpacing: 2, children: [
              if (viewer == VendorViewer.admin) _who(LucideIcons.store, 'Vendor', _name(a.vendorName, a.vendorId)),
              if (viewer == VendorViewer.admin) _who(LucideIcons.shieldCheck, 'Subadmin', _name(a.managerName, a.managedByUserId, empty: 'Unassigned')),
              _who(LucideIcons.userCircle, 'Merchant', _name(a.assignedUserName, a.assignedUserId, empty: 'Unassigned')),
            ]),
          ],
```

and add these two helpers to the card, next to `_kv`:

```dart
  String _name(String? serverName, String? id, {String empty = '—'}) =>
      names?.nameOr(serverName, id, empty: empty) ?? ((serverName ?? '').isNotEmpty ? serverName! : (id ?? empty));

  Widget _who(IconData icon, String k, String v) => Row(mainAxisSize: MainAxisSize.min, children: [
        Icon(icon, size: 12, color: AppColors.textMuted),
        const SizedBox(width: 4),
        Text('$k ', style: AppTypography.caption().copyWith(letterSpacing: 0)),
        Text(v,
            style: AppTypography.bodySm(color: v == 'Unassigned' ? AppColors.textMuted : AppColors.textPrimary)
                .copyWith(fontWeight: FontWeight.w700)),
      ]);
```

The vendor and merchant views keep showing no who-row. `accountHolderName` stays where it is, under the
bank + number line.

## Change 5: detail screens use the server names

`lib/vendor/VendorAccountsPage.dart` → `_VendorAccountDetailPageState`, in the "Details" section:

```dart
        if (v == VendorViewer.admin) ...[
          VKv('Vendor', _names.nameOr(a.vendorName, a.vendorId)),
          VKv('Subadmin', _names.nameOr(a.managerName, a.managedByUserId, empty: 'Unassigned')),
          VKv('Merchant', _names.nameOr(a.assignedUserName, a.assignedUserId, empty: 'Unassigned')),
          // …Reviewed line unchanged
        ],
        if (v == VendorViewer.subadmin) VKv('Merchant', _names.nameOr(a.assignedUserName, a.assignedUserId, empty: 'Unassigned')),
```

`lib/vendor/AdminVendorsPages.dart` → `AdminVendorDetailPage`, the accounts-table caption
(`'Merchant … · Subadmin …'`):

```dart
                Text(
                  'Subadmin ${_names.nameOr(a.managerName, a.managedByUserId, empty: 'Unassigned')} · Merchant ${_names.nameOr(a.assignedUserName, a.assignedUserId, empty: 'Unassigned')}',
                  style: AppTypography.caption().copyWith(letterSpacing: 0),
                ),
```

## Change 6: `lib/vendor/VendorAccountsPage.dart` → filters on `VendorAccountsPage`

### 6a. State (in `_VendorAccountsPageState`, under `_state/_mode/_type`)

```dart
  // Who-filters: '' = all, 'none' = unassigned (server contract), else a user id.
  String _vendorF = '';
  String _managerF = '';
  String _merchantF = '';
  List<VendorRow> _vendors = const [];

  String? _nz(String s) => s.isEmpty ? null : s;
  bool get _whoFiltered => _vendorF.isNotEmpty || _managerF.isNotEmpty || _merchantF.isNotEmpty;
```

### 6b. `_init()`: admin also loads the vendor list for the Vendor filter

```dart
  Future<void> _init() async {
    if (v == VendorViewer.admin || v == VendorViewer.subadmin) await _names.loadUsers();
    if (v == VendorViewer.admin && widget.vendorId == null) {
      try {
        _vendors = (await VendorService.vendors(limit: 100)).items; // first 100 vendors; page if ever more
      } catch (_) {}
    }
    await _load();
  }
```

### 6c. `_load()`: send the filters

```dart
      final p = await VendorService.accounts(
        state: _state,
        mode: _mode,
        accountType: _type,
        vendorId: widget.vendorId ?? (v == VendorViewer.admin ? _nz(_vendorF) : null),
        managedByUserId: v == VendorViewer.admin ? _nz(_managerF) : null,
        assignedUserId: (v == VendorViewer.admin || v == VendorViewer.subadmin) ? _nz(_merchantF) : null,
        cursor: more ? _cursor : null,
      );
```

### 6d. `_filters()`: a who-row above the existing admin Mode/Type row

Insert this block just before the existing `if (v == VendorViewer.admin) ...[` (Mode/Type):

```dart
          if (v == VendorViewer.admin || v == VendorViewer.subadmin) ...[
            const SizedBox(height: Sp.xs),
            Wrap(spacing: Sp.xs, runSpacing: Sp.xs, children: _whoChips()),
          ],
```

and add these to the state class:

```dart
  /// Merchants offered in the Merchant filter: a subadmin's own merchants; for
  /// admin, the chosen subadmin's merchants (or every merchant).
  List<AppUser> get _merchantOptions {
    final parent = v == VendorViewer.subadmin
        ? widget.userMeta.id
        : (_managerF.isNotEmpty && _managerF != 'none' ? _managerF : null);
    final list = _names.users.where((u) => u.role == 'user' && (parent == null || u.parentId == parent)).toList();
    list.sort((a, b) => _names.userName(a.id).toLowerCase().compareTo(_names.userName(b.id).toLowerCase()));
    return list;
  }

  List<Widget> _whoChips() {
    String who(String id, String Function(String) name, String unassigned) =>
        id.isEmpty ? '' : (id == 'none' ? unassigned : name(id));
    void apply(VoidCallback f) {
      setState(f);
      _load();
    }

    final subs = _names.users.where((u) => u.role == 'subadmin').toList()
      ..sort((a, b) => _names.userName(a.id).toLowerCase().compareTo(_names.userName(b.id).toLowerCase()));
    final merchants = _merchantOptions;
    return [
      if (v == VendorViewer.admin && widget.vendorId == null)
        NpDropdownChip<String>(
          label: 'Vendor',
          icon: LucideIcons.store,
          active: _vendorF.isNotEmpty,
          value: _vendorF,
          items: ['', for (final r in _vendors) r.userId],
          itemLabel: (id) => id.isEmpty
              ? 'All vendors'
              : who(id, (x) => _vendors.firstWhere((r) => r.userId == x, orElse: () => VendorRow(userId: x, name: x, email: '')).name, ''),
          onSelected: (id) => apply(() => _vendorF = id),
        ),
      if (v == VendorViewer.admin)
        NpDropdownChip<String>(
          label: 'Subadmin',
          icon: LucideIcons.shieldCheck,
          active: _managerF.isNotEmpty,
          value: _managerF,
          items: ['', 'none', for (final u in subs) u.id],
          itemLabel: (id) => id.isEmpty ? 'All subadmins' : who(id, (x) => _names.userName(x), 'No subadmin'),
          onSelected: (id) => apply(() {
            _managerF = id;
            // Keep the merchant filter only if it still belongs to the chosen subadmin.
            if (_merchantF.isNotEmpty && _merchantF != 'none' && !_merchantOptions.any((u) => u.id == _merchantF)) _merchantF = '';
          }),
        ),
      NpDropdownChip<String>(
        label: 'Merchant',
        icon: LucideIcons.userCircle,
        active: _merchantF.isNotEmpty,
        value: _merchantF,
        items: ['', 'none', for (final u in merchants) u.id],
        itemLabel: (id) => id.isEmpty ? 'All merchants' : who(id, (x) => _names.userName(x), 'No merchant'),
        onSelected: (id) => apply(() => _merchantF = id),
      ),
      if (_whoFiltered)
        NpFilterChip(
          label: 'Clear',
          selected: false,
          onTap: () => apply(() {
            _vendorF = '';
            _managerF = '';
            _merchantF = '';
          }),
        ),
    ];
  }
```

Notes:
- `VendorRow` (in `models/VendorModels.dart`) needs only `userId`, `name` and `email`, which is what the `orElse` passes.
- The subadmin's merchant list comes from `_names.users` (their own users). The vendor and merchant views
  get no who-filters.
- The review queue (`initialState != null`) hides `_filters()` entirely. Leave that as it is.

### 6e. Subtitles in `build()`

```dart
          VendorViewer.admin => 'Every vendor account · filter by vendor, subadmin, merchant, state, mode, type',
          VendorViewer.subadmin => 'Accounts admin gave to you · assign and filter by merchant',
```

### Handy presets (optional quick chips for admin)

| Chip | Params |
|---|---|
| Not given to a subadmin | `state=active&managedByUserId=none` |
| With a subadmin, no merchant yet | `managedByUserId=<sub>&assignedUserId=none` |

---

## Acceptance checklist

1. **Admin** account list: every card shows **Vendor · Subadmin · Merchant** with real names ("Unassigned"
   in muted text when empty), and the bank-account holder name under the bank line.
2. **Admin** Vendor filter → only that vendor's accounts; Subadmin filter → only theirs; "No subadmin" → only
   unassigned ones; Merchant list narrows to the chosen subadmin's merchants; Clear resets all three; filters
   combine with the state chips and Mode/Type.
3. **Admin → vendor detail → accounts** (`widget.vendorId` set): no Vendor chip; Subadmin/Merchant still work.
4. **Subadmin**: cards show **Merchant** only; the Merchant filter lists only their merchants plus "No
   merchant"; there's no vendor anywhere.
5. **Vendor app**: cards show no subadmin or merchant names and there are no who-filters.
6. **Merchant**: unchanged.
7. **Account detail** (admin): the Vendor/Subadmin/Merchant rows show names even for users outside the first
   page of `loadUsers()`.
8. With the API not yet deployed, the list must still render (names fall back to the local lookup or ids).
   Just don't sign off on the filters until the deploy.
