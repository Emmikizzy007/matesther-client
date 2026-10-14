// Stage and support inspections have independent ID sequences. Preserve the
// source selected in the evidence picker so an overlapping numeric ID never
// identifies a different worker's/inspection type's damage case.
export function damageInspectionPayload(selection: string):
  { incidentInspectionId: number } | { incidentSupportInspectionId: number } {
  const match = /^(STAGE|SUPPORT):([1-9]\d*)$/.exec(selection);
  const id = match ? Number(match[2]) : NaN;
  if (!match || !Number.isSafeInteger(id))
    throw new Error("Choose one rejected stage or support-work inspection.");
  return match[1] === "STAGE" ? { incidentInspectionId: id } : { incidentSupportInspectionId: id };
}
