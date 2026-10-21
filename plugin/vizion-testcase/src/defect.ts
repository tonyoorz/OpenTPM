export interface OctaneReference {
  type: string;
  id: string;
}

export interface DefectTextField {
  fieldName: string;
  value: string;
}

export interface DefectReferenceField {
  fieldName: string;
  reference: OctaneReference;
}

export interface DefectMultiReferenceField {
  fieldName: string;
  references: OctaneReference[];
}

export interface DefectTicketDraft {
  name: string;
  descriptionHtml: string;
  severity: OctaneReference;
  phase: OctaneReference;
  owner: OctaneReference;
  team?: OctaneReference;
  problemFinderTeam?: OctaneReference;
  detectedInRelease?: OctaneReference;
  assignedEcu?: OctaneReference;
  leadModel?: OctaneReference;
  softwareVersion?: string;
  vin?: string;
  productAreas?: OctaneReference[];
  customTextFields?: DefectTextField[];
  customReferenceFields?: DefectReferenceField[];
  customMultiReferenceFields?: DefectMultiReferenceField[];
}

export type OctaneDefectFieldValue = string | OctaneReference | { data: OctaneReference[] };
export type OctaneDefectFields = Record<string, OctaneDefectFieldValue>;

const fieldNamePattern = /^[A-Za-z][A-Za-z0-9_]*$/;
const reservedEntityFieldNames = new Set(['type', 'id']);

function assertReference(reference: OctaneReference, fieldName: string): void {
  if (!reference.type.trim() || !reference.id.trim()) {
    throw new Error(`${fieldName} requires a reference type and id`);
  }
}

function addReference(
  fields: OctaneDefectFields,
  fieldName: string,
  reference: OctaneReference | undefined,
): void {
  if (!reference) return;
  assertReference(reference, fieldName);
  fields[fieldName] = reference;
}

function assertCustomFieldName(fieldName: string, fields: OctaneDefectFields): void {
  if (!fieldNamePattern.test(fieldName)) {
    throw new Error(`invalid Octane field name: ${fieldName}`);
  }
  if (reservedEntityFieldNames.has(fieldName)) {
    throw new Error(`custom field ${fieldName} cannot overwrite a reserved Octane entity field`);
  }
  if (Object.hasOwn(fields, fieldName)) {
    throw new Error(`custom field ${fieldName} cannot overwrite a standard Defect field`);
  }
}

export function buildDefectFields(draft: DefectTicketDraft): OctaneDefectFields {
  if (!draft.name.trim() || !draft.descriptionHtml.trim()) {
    throw new Error('name and descriptionHtml are required');
  }
  assertReference(draft.severity, 'severity');
  assertReference(draft.phase, 'phase');
  assertReference(draft.owner, 'owner');

  const fields: OctaneDefectFields = {
    name: draft.name,
    description: draft.descriptionHtml,
    severity: draft.severity,
    phase: draft.phase,
    owner: draft.owner,
  };

  addReference(fields, 'team', draft.team);
  addReference(fields, 'problem_finder_team_udf', draft.problemFinderTeam);
  addReference(fields, 'detected_in_release', draft.detectedInRelease);
  addReference(fields, 'assigned_ecu_udf', draft.assignedEcu);
  addReference(fields, 'lead_model_udf', draft.leadModel);

  if (draft.softwareVersion?.trim()) {
    fields['software_version_udf'] = draft.softwareVersion;
  }
  if (draft.vin?.trim()) {
    fields['vin_udf'] = draft.vin;
  }
  if (draft.productAreas?.length) {
    draft.productAreas.forEach((reference) => assertReference(reference, 'product_areas'));
    fields['product_areas'] = { data: draft.productAreas };
  }

  for (const field of draft.customTextFields ?? []) {
    assertCustomFieldName(field.fieldName, fields);
    fields[field.fieldName] = field.value;
  }
  for (const field of draft.customReferenceFields ?? []) {
    assertCustomFieldName(field.fieldName, fields);
    assertReference(field.reference, field.fieldName);
    fields[field.fieldName] = field.reference;
  }
  for (const field of draft.customMultiReferenceFields ?? []) {
    assertCustomFieldName(field.fieldName, fields);
    field.references.forEach((reference) => assertReference(reference, field.fieldName));
    fields[field.fieldName] = { data: field.references };
  }

  return fields;
}