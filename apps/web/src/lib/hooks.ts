"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { semesterApi, sectionApi, type Semester } from "@/lib/api";
import { useAuthStore } from "@/store/authStore";

/** Token for authenticated queries; components should treat `null` as "not ready". */
export function useToken() {
  return useAuthStore((s) => s.token);
}

/**
 * Loads semesters and keeps a selected one. Defaults to the ACTIVE semester
 * (falling back to the most recent) so admin pages open on something useful
 * instead of an empty picker.
 */
export function useSemesters() {
  const token = useToken();
  const [semesterId, setSemesterId] = useState<string>("");

  const query = useQuery({
    queryKey: ["semesters"],
    queryFn: () => semesterApi.list(token!),
    enabled: !!token,
  });

  useEffect(() => {
    if (semesterId || !query.data?.length) return;
    const active = query.data.find((s: Semester) => s.status === "ACTIVE");
    setSemesterId((active ?? query.data[0]).id);
  }, [query.data, semesterId]);

  return { semesters: query.data ?? [], semesterId, setSemesterId, isLoading: query.isLoading };
}

/** Sections for a semester; disabled until a semester is chosen. */
export function useSections(semesterId: string) {
  const token = useToken();
  return useQuery({
    queryKey: ["sections", semesterId],
    queryFn: () => sectionApi.list(token!, semesterId),
    enabled: !!token && !!semesterId,
  });
}

export const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Local (not UTC) YYYY-MM-DD — avoids the off-by-one-day bug from toISOString(). */
export function toDateInput(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
