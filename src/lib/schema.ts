export const DB_SCHEMA = `
Database table: odata_tw___job_cost
Each row has a JSONB column called "data" containing job cost information.

IMPORTANT: JobID values have trailing spaces — always use TRIM(data->>'JobID').
IMPORTANT: Numeric fields are stored as text strings — cast with (NULLIF(data->>'FieldName',''))::numeric
IMPORTANT: StartDate and EndDate are Excel serial date numbers (days since 1899-12-30), not real dates.

Available fields in the data JSONB column:
- JobID: text — unique job identifier (e.g. "22123")
- Description: text — job description/name
- Task: text — task code within the job (e.g. "CONTRACT", "LABOR")
- Branch: text — branch/division (e.g. "ABC1", "ABC2")
- StartDate: text — Excel serial date number (convert with: DATE '1899-12-30' + interval '1 day' * value::integer)
- EndDate: text — Excel serial date number
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
