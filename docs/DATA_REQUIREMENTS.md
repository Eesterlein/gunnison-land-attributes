# Data requirements: RealWare ListBuilder searches

This is the data the dashboard needs from RealWare, written so a ListBuilder search can be built for each dataset. The live version of the app will run these saved searches through the Encompass API (`POST /api/listbuilder/realware/{queryId}`), once a week and whenever someone clicks **Refresh**.

**General rules for every search**
- **Accounts:** active accounts only, current tax year.
- **Column names:** keep them exactly as listed. The API returns each column as a JSON field named after the column alias, and the app matches on those names. If a name has to differ, note it in the table so the app can be mapped to it.
- **Row count:** the API returns at most 500 rows unless the call asks for more (`maxResults`). Please check with HGO or IT what the maximum allowed is. The land attribute search can run to roughly 150,000 rows.
- **Data:** no owner names or mailing addresses are needed in any search.

---

## 1. Accounts: existing search `PUBLIC INFO - ACCT OWNERSHIP`

One row per account. The existing search already has what's needed. Owner columns can stay; the app ignores them.

| Column | Example | Used for |
|---|---|---|
| `ACCOUNT NO` | R000037 | Key for everything |
| `ACCOUNT TYPE` | Residential | Filters, coverage stats |
| `PARCEL NO` | 3701-360-01-001 | Links the account to the map when the account number isn't on the parcel shape |
| `IMPROVED PROPERTY TYPE` | Condo | Condo / improved-vs-vacant logic |
| `PROPERTY ADDRESS` | 900 N MAIN ST | Search, parcel card |
| `SUBDIVISION NAME` | MEADOWS SUBDIVISION | Neighbor comparison, search |
| `CONDO NAME` | | Condo detection |
| `ECONOMIC AREA CODE` | 1 | Filter |
| **`NEIGHBORHOOD`** *(to add; the field is still being confirmed)* | | Filter, requested in place of Area |

## 2. Values: existing search `PUBLIC INFO - VALUES`

One row per account. The existing search is fine. Only these columns are used:

| Column | Used for |
|---|---|
| `ACCOUNT NO` | Key |
| `<year> LAND ACTUAL` | Parcel card |
| `<year> IMPROVEMENTS ACTUAL` | Parcel card; "improved" test (value > 0) |
| `<year> TOTAL ACTUAL` | Parcel card |

## 3. Sales: existing search `PUBLIC INFO - SALES`

One row per sale per account. The existing search is fine. Only these columns are used:

| Column | Used for |
|---|---|
| `ACCOUNT NO` | Key |
| `RECEPTION NO` | Identifies the sale |
| `SALE DATE` | Appraisal-period filter, map labels |
| `SALE PRICE` | Map labels |
| `ADJUSTED SALE PRICE` | Map labels |
| `TYPE OF TRANSACTION` | `QUALIFIED SALE` = valid sale |
| `INVALID SALE REASON` | Parcel card |

**Nice to have:** a sale-date parameter (start and end date), so the app only pulls sales in the appraisal period it needs, not all 71,000 rows back to 1916.

## 4. Land attributes: **new search needed**

The current Land Attributes download comes from an SSMS query. There are two ways to turn it into a ListBuilder search.

### Option A (fastest): reuse the SSMS query
If this RealWare version has the ListBuilder **Raw SQL** editor (V6 and later), the existing SSMS query may work nearly as-is. The app already knows how to read its output. Please send the SQL text itself (just the query, no data) so it can be checked first.

Two quirks in the current output would be good to fix while you're in there, but they aren't required:
- **Header row is shifted:** the `LAND TYPE` header sits over the legal description, and `SUBDIVISION` sits over the land-use class.
- **`OTHER ATTRIBUTES` is packed:** all the attributes are combined into one text field, which the app has to split apart.

### Option B (cleanest): two tidy searches

**4a. Land attributes, one row per attribute per account**

This is the format RealWare already stores internally (`LandAttributes` → `AttributeType` / `AttributeSubType` in the API). It covers every attribute, including any new types added later, without changes to the app.

| Column | Example |
|---|---|
| `ACCOUNT NO` | R000942 |
| `ATTRIBUTE TYPE` | VIEWS |
| `ATTRIBUTE SUBTYPE` | SCENIC OR ABOVE AVERAGE |

The following should all come through as attribute rows: Land Type Primary, Land Type Secondary, Views, Unique Characteristics, Site Access, Electricity, Sewer, Water, Easement, Deed Restricted, Mining District, and Arrowhead lot attributes. If any of these are stored as separate fields rather than attributes, add them as extra columns in 4b instead.

**4b. Land lines, one row per land line per account**

| Column | Example | Used for |
|---|---|---|
| `ACCOUNT NO` | R000942 | Key |
| `LAND ABSTRACT CODE` / description | Residential | Land Use Class |
| `LEA CODE` | 10000 | LEA filter and attribute |
| `LEA DESCRIPTION` | GUNNISON RESIDENTIAL IMPROVED | LEA filter and attribute |
| `LAND ACRES` | 0.215 | Parcel card |
| `LAND SF` | 9375 | Parcel card |

---

## What to send back

1. **The saved-search IDs** (`queryId`) for each of the four searches. `GET /api/listbuilder/realware/savedsearches` lists them.
2. **A small sample of each search's API output**, about 20 rows each, saved as `.json`. It's run through the API with `POST /api/listbuilder/realware/{queryId}?maxResults=20`. **These samples stay local: put them in the `api-samples/` folder, which git ignores, so they are never committed to GitHub.**
3. **The neighborhood field:** its name and a few example values.
4. **The maximum `maxResults`** the API allows.
