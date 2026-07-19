export interface JobData {
  jobId: string;
  jobName: string;
  tradeType: string;
  revenue: number;
  cost: number;
  profit: number;
  marginPercent: number;
  status: string;
}

interface CacheEntry {
  data: JobData[];
  timestamp: number;
  isDemo: boolean;
}

const cache = new Map<string, CacheEntry>();
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

const ACUMATICA_URL = process.env.ACUMATICA_URL || "https://your-instance.acumatica.com";
const ACUMATICA_USERNAME = process.env.ACUMATICA_USERNAME || "";
const ACUMATICA_PASSWORD = process.env.ACUMATICA_PASSWORD || "";
const ACUMATICA_TENANT = process.env.ACUMATICA_TENANT || "";

async function loginToAcumatica(): Promise<string | null> {
  try {
    const loginUrl = `${ACUMATICA_URL}/entity/auth/login`;
    const response = await fetch(loginUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: ACUMATICA_USERNAME,
        password: ACUMATICA_PASSWORD,
        company: ACUMATICA_TENANT,
      }),
    });

    if (!response.ok) {
      console.error("Acumatica login failed:", response.status, await response.text());
      return null;
    }

    const setCookieHeader = response.headers.get("set-cookie");
    if (!setCookieHeader) {
      console.error("No session cookie returned from Acumatica");
      return null;
    }

    return setCookieHeader;
  } catch (err) {
    console.error("Acumatica login error:", err);
    return null;
  }
}

async function logoutFromAcumatica(sessionCookie: string): Promise<void> {
  try {
    await fetch(`${ACUMATICA_URL}/entity/auth/logout`, {
      method: "POST",
      headers: { Cookie: sessionCookie },
    });
  } catch {
    // Ignore logout errors
  }
}

async function getJobData(sessionCookie: string): Promise<JobData[]> {
  const baseUrl = `${ACUMATICA_URL}/entity/Default/23.200.001`;
  const projectsUrl = `${baseUrl}/Project?\$select=ProjectID,Description,Status,BudgetLevel&\$expand=CostBudget,RevenueBudget`;
  const response = await fetch(projectsUrl, {
    headers: {
      Cookie: sessionCookie,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch projects: ${response.status}`);
  }

  const projects = await response.json();

  if (!Array.isArray(projects)) {
    throw new Error("Unexpected response format from Acumatica");
  }

  const jobs: JobData[] = projects.map((project: Record<string, unknown>) => {
    const projectId = (project.ProjectID as Record<string, string>)?.value || "";
    const description = (project.Description as Record<string, string>)?.value || projectId;
    const status = (project.Status as Record<string, string>)?.value || "Unknown";

    let revenue = 0;
    const revenueBudget = project.RevenueBudget as Array<Record<string, unknown>>;
    if (Array.isArray(revenueBudget)) {
      revenue = revenueBudget.reduce((sum: number, line: Record<string, unknown>) => {
        const amt = (line.RevisedAmount as Record<string, number>)?.value || 0;
        return sum + amt;
      }, 0);
    }

    let cost = 0;
    const costBudget = project.CostBudget as Array<Record<string, unknown>>;
    if (Array.isArray(costBudget)) {
      cost = costBudget.reduce((sum: number, line: Record<string, unknown>) => {
        const amt = (line.RevisedAmount as Record<string, number>)?.value || 0;
        return sum + amt;
      }, 0);
    }

    const profit = revenue - cost;
    const marginPercent = revenue > 0 ? (profit / revenue) * 100 : 0;
    const tradeType = inferTradeType(projectId, description);

    return {
      jobId: projectId,
      jobName: description,
      tradeType,
      revenue,
      cost,
      profit,
      marginPercent: Math.round(marginPercent * 10) / 10,
      status,
    };
  });

  return jobs.filter((j) => j.jobId !== "");
}

function inferTradeType(projectId: string, description: string): string {
  const text = (projectId + " " + description).toLowerCase();
  if (text.includes("roof")) return "Roofing";
  if (text.includes("sid")) return "Siding";
  if (text.includes("deck")) return "Decking";
  if (text.includes("window") || text.includes("door")) return "Windows & Doors";
  if (text.includes("gutter")) return "Gutters";
  return "General";
}

function getMockData(): JobData[] {
  return [
    { jobId: "ROOF-001", jobName: "Smith Residence - Roof Replacement", tradeType: "Roofing", revenue: 18500, cost: 12800, profit: 5700, marginPercent: 30.8, status: "Completed" },
    { jobId: "ROOF-002", jobName: "Johnson Commercial Roofing", tradeType: "Roofing", revenue: 42000, cost: 31500, profit: 10500, marginPercent: 25.0, status: "Completed" },
    { jobId: "ROOF-003", jobName: "Brown Shingle Replacement", tradeType: "Roofing", revenue: 9800, cost: 7200, profit: 2600, marginPercent: 26.5, status: "Active" },
    { jobId: "SID-001", jobName: "Davis Vinyl Siding Install", tradeType: "Siding", revenue: 22000, cost: 15400, profit: 6600, marginPercent: 30.0, status: "Completed" },
    { jobId: "SID-002", jobName: "Wilson Fiber Cement Siding", tradeType: "Siding", revenue: 35000, cost: 27300, profit: 7700, marginPercent: 22.0, status: "Active" },
    { jobId: "SID-003", jobName: "Martinez Siding Repair", tradeType: "Siding", revenue: 4500, cost: 3600, profit: 900, marginPercent: 20.0, status: "Completed" },
    { jobId: "DECK-001", jobName: "Thompson Composite Deck", tradeType: "Decking", revenue: 28000, cost: 19600, profit: 8400, marginPercent: 30.0, status: "Completed" },
    { jobId: "DECK-002", jobName: "Anderson Pressure Treat Deck", tradeType: "Decking", revenue: 14500, cost: 11600, profit: 2900, marginPercent: 20.0, status: "Active" },
    { jobId: "WIN-001", jobName: "Garcia Window Replacement 12x", tradeType: "Windows & Doors", revenue: 19800, cost: 14200, profit: 5600, marginPercent: 28.3, status: "Completed" },
    { jobId: "WIN-002", jobName: "Lee Entry Door System", tradeType: "Windows & Doors", revenue: 8200, cost: 5900, profit: 2300, marginPercent: 28.0, status: "Completed" },
    { jobId: "GUT-001", jobName: "Robinson Seamless Gutters", tradeType: "Gutters", revenue: 3800, cost: 2400, profit: 1400, marginPercent: 36.8, status: "Completed" },
    { jobId: "GUT-002", jobName: "Clark Gutter Guard System", tradeType: "Gutters", revenue: 5200, cost: 3640, profit: 1560, marginPercent: 30.0, status: "Active" },
    { jobId: "ROOF-004", jobName: "White Metal Roof Install", tradeType: "Roofing", revenue: 31000, cost: 24180, profit: 6820, marginPercent: 22.0, status: "Active" },
    { jobId: "SID-004", jobName: "Harris Cedar Shake Siding", tradeType: "Siding", revenue: 41000, cost: 28700, profit: 12300, marginPercent: 30.0, status: "Completed" },
    { jobId: "DECK-003", jobName: "Taylor Pool Deck Expansion", tradeType: "Decking", revenue: 19000, cost: 15200, profit: 3800, marginPercent: 20.0, status: "Completed" },
  ];
}

export async function getJobsWithCache(): Promise<{ data: JobData[]; isDemo: boolean }> {
  const cacheKey = "jobs";
  const cached = cache.get(cacheKey);

  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return { data: cached.data, isDemo: cached.isDemo };
  }

  let sessionCookie: string | null = null;

  try {
    sessionCookie = await loginToAcumatica();

    if (!sessionCookie) {
      console.warn("Acumatica login failed, using mock data");
      const mockData = getMockData();
      cache.set(cacheKey, { data: mockData, timestamp: Date.now(), isDemo: true });
      return { data: mockData, isDemo: true };
    }

    const jobs = await getJobData(sessionCookie);
    cache.set(cacheKey, { data: jobs, timestamp: Date.now(), isDemo: false });
    return { data: jobs, isDemo: false };
  } catch (err) {
    console.error("Failed to fetch Acumatica job data:", err);
    const mockData = getMockData();
    cache.set(cacheKey, { data: mockData, timestamp: Date.now(), isDemo: true });
    return { data: mockData, isDemo: true };
  } finally {
    if (sessionCookie) {
      await logoutFromAcumatica(sessionCookie);
    }
  }
}