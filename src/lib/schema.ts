export const DB_SCHEMA = `
Database table: odata_tw___job_cost
Each row has a JSONB column called "data" containing job cost information.

CRITICAL RULES - follow these exactly or queries will fail:

1. NUMERIC FIELDS: Never cast directly. Always use:
   COALESCE((NULLIF(data->>'FieldName',''))::numeric, 0)

2. DATE FIELDS (StartDate, EndDate): Stored as ISO timestamp strings like "2026-07-07T00:00:00".
   They may be empty strings. Always guard with NULLIF before casting:
   (NULLIF(data->>'EndDate',''))::timestamp

   Safe date filter pattern:
   NULLIF(data->>'EndDate','') IS NOT NULL
   AND (NULLIF(data->>'EndDate',''))::timestamp >= [date expression]

   NEVER do: (data->>'EndDate')::timestamp — crashes on empty strings.
   NEVER do: (data->>'EndDate')::integer — dates are NOT Excel serial numbers.

3. JOBID: Always TRIM(data->>'JobID') and filter WHERE TRIM(data->>'JobID') != ''

4. AGGREGATION: Always GROUP BY TRIM(data->>'JobID') when calculating per-job metrics

5. LIMIT: Put LIMIT on the outer query, never inside a subquery that feeds an aggregate (AVG, SUM, COUNT)

Safe date filter example (jobs ending last month):
WHERE TRIM(data->>'JobID') != ''
  AND NULLIF(data->>'EndDate','') IS NOT NULL
  AND (NULLIF(data->>'EndDate',''))::timestamp >= DATE_TRUNC('month', CURRENT_DATE - INTERVAL '1 month')
  AND (NULLIF(data->>'EndDate',''))::timestamp < DATE_TRUNC('month', CURRENT_DATE)

Available fields in the data JSONB column:
- JobID: text — unique job identifier (e.g. "22123")
- Description: text — job description/name
- Task: text — task code within the job (e.g. "CONTRACT", "LABOR")
- Branch: text — branch/division (e.g. "ABC1", "ABC2")
- StartDate: text — ISO timestamp string (e.g. "2026-01-15T00:00:00"), may be empty. Safe cast: (NULLIF(data->>'StartDate',''))::timestamp
- EndDate: text — ISO timestamp string (e.g. "2026-07-07T00:00:00"), may be empty. Safe cast: (NULLIF(data->>'EndDate',''))::timestamp
- ActualRevenue: numeric text — actual revenue billed
- BudgetedRevenue: numeric text — budgeted/contracted revenue
- ActualLabor: numeric text — actual labor costs
- BudgetedLabor: numeric text — budgeted labor costs
- ActualSubs: numeric text — actual subcontractor costs
- BudgetedSubs: numeric text — budgeted subcontractor costs
- ActualMaterials: numeric text — actual material costs
- BudgetedMaterials: numeric text — budgeted material costs
- ActualDisposal: numeric text — actual disposal costs
- BudgetedDisposal: numeric text — budgeted disposal costs
- ActualOther: numeric text — actual other costs
- BudgetedOther: numeric text — budgeted other costs

Common derived calculations:
- Total Actual Cost = ActualLabor + ActualSubs + ActualMaterials + ActualDisposal + ActualOther
- Profit = ActualRevenue - Total Actual Cost
- Margin % = Profit / ActualRevenue * 100 (when ActualRevenue > 0)
- Budget Variance = BudgetedRevenue - ActualRevenue

To aggregate by job (since each job has multiple task rows):
SELECT
  TRIM(data->>'JobID') as job_id,
  MAX(data->>'Description') as description,
  MAX(data->>'Branch') as branch,
  SUM(COALESCE((NULLIF(data->>'ActualRevenue',''))::numeric, 0)) as actual_revenue,
  SUM(COALESCE((NULLIF(data->>'BudgetedRevenue',''))::numeric, 0)) as budgeted_revenue,
  SUM(COALESCE((NULLIF(data->>'ActualLabor',''))::numeric, 0)) as actual_labor,
  SUM(COALESCE((NULLIF(data->>'ActualSubs',''))::numeric, 0)) as actual_subs,
  SUM(COALESCE((NULLIF(data->>'ActualMaterials',''))::numeric, 0)) as actual_materials,
  SUM(COALESCE((NULLIF(data->>'ActualDisposal',''))::numeric, 0)) as actual_disposal,
  SUM(COALESCE((NULLIF(data->>'ActualOther',''))::numeric, 0)) as actual_other
FROM odata_tw___job_cost
WHERE TRIM(data->>'JobID') != ''
GROUP BY TRIM(data->>'JobID')
`;
