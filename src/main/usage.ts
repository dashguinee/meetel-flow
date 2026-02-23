import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const USAGE_DIR = path.join(os.homedir(), ".meetel-flow");
const USAGE_FILE = path.join(USAGE_DIR, "usage.json");

type UsageData = {
  month: string;
  minutesUsed: number;
  limit: number;
};

const DEFAULT_LIMIT = 100;

const currentMonth = (): string => {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
};

const readUsage = (): UsageData => {
  try {
    if (!fs.existsSync(USAGE_FILE)) {
      return { month: currentMonth(), minutesUsed: 0, limit: DEFAULT_LIMIT };
    }
    const raw = fs.readFileSync(USAGE_FILE, "utf-8");
    const parsed = JSON.parse(raw) as UsageData;

    // Auto-reset on new month
    if (parsed.month !== currentMonth()) {
      return { month: currentMonth(), minutesUsed: 0, limit: parsed.limit || DEFAULT_LIMIT };
    }

    return parsed;
  } catch {
    return { month: currentMonth(), minutesUsed: 0, limit: DEFAULT_LIMIT };
  }
};

const writeUsage = (data: UsageData): void => {
  fs.mkdirSync(USAGE_DIR, { recursive: true });
  fs.writeFileSync(USAGE_FILE, JSON.stringify(data, null, 2), "utf-8");
};

export const getUsage = (): UsageData => {
  return readUsage();
};

export const addUsage = (seconds: number): void => {
  const data = readUsage();
  data.minutesUsed = Math.round((data.minutesUsed + seconds / 60) * 100) / 100;
  writeUsage(data);
};

export const hasMinutesRemaining = (): boolean => {
  const data = readUsage();
  return data.minutesUsed < data.limit;
};

export const getRemainingMinutes = (): number => {
  const data = readUsage();
  return Math.max(0, Math.round((data.limit - data.minutesUsed) * 100) / 100);
};
