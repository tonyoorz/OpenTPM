import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DefectTicketDraft, OctaneReference } from './defect.js';
import { buildDefectFields } from './defect.js';
import { buildDefectUrl, createDefect } from './octane.js';

const octaneReferenceSchema = z.object({
  type: z.string().min(1),
  id: z.string().min(1),
});

const defectTicketInputSchema = {
  name: z.string().min(1),
  description_html: z.string().min(1),
  severity: octaneReferenceSchema,
  phase: octaneReferenceSchema,
  owner: octaneReferenceSchema,
  team: octaneReferenceSchema.optional(),
  problem_finder_team: octaneReferenceSchema.optional(),
  detected_in_release: octaneReferenceSchema.optional(),
  assigned_ecu: octaneReferenceSchema.optional(),
  lead_model: octaneReferenceSchema.optional(),
  software_version: z.string().optional(),
  vin: z.string().optional(),
  product_areas: z.array(octaneReferenceSchema).optional(),
  custom_text_fields: z.array(z.object({
    field_name: z.string().min(1),
    value: z.string(),
  })).optional(),
  custom_reference_fields: z.array(z.object({
    field_name: z.string().min(1),
    reference: octaneReferenceSchema,
  })).optional(),
  custom_multi_reference_fields: z.array(z.object({
    field_name: z.string().min(1),
    references: z.array(octaneReferenceSchema).min(1),
  })).optional(),
};

interface DefectTicketInput {
  name: string;
  description_html: string;
  severity: OctaneReference;
  phase: OctaneReference;
  owner: OctaneReference;
  team?: OctaneReference;
  problem_finder_team?: OctaneReference;
  detected_in_release?: OctaneReference;
  assigned_ecu?: OctaneReference;
  lead_model?: OctaneReference;
  software_version?: string;
  vin?: string;
  product_areas?: OctaneReference[];
  custom_text_fields?: { field_name: string; value: string }[];
  custom_reference_fields?: { field_name: string; reference: OctaneReference }[];
  custom_multi_reference_fields?: { field_name: string; references: OctaneReference[] }[];
}

interface DefectTicketToolDependencies {
  createDefect?: typeof createDefect;
  buildDefectUrl?: typeof buildDefectUrl;
}

function toDefectTicketDraft(input: DefectTicketInput): DefectTicketDraft {
  return {
    name: input.name,
    descriptionHtml: input.description_html,
    severity: input.severity,
    phase: input.phase,
    owner: input.owner,
    team: input.team,
    problemFinderTeam: input.problem_finder_team,
    detectedInRelease: input.detected_in_release,
    assignedEcu: input.assigned_ecu,
    leadModel: input.lead_model,
    softwareVersion: input.software_version,
    vin: input.vin,
    productAreas: input.product_areas,
    customTextFields: input.custom_text_fields?.map((field) => ({
      fieldName: field.field_name,
      value: field.value,
    })),
    customReferenceFields: input.custom_reference_fields?.map((field) => ({
      fieldName: field.field_name,
      reference: field.reference,
    })),
    customMultiReferenceFields: input.custom_multi_reference_fields?.map((field) => ({
      fieldName: field.field_name,
      references: field.references,
    })),
  };
}

export function registerDefectTicketTools(
  server: McpServer,
  dependencies: DefectTicketToolDependencies = {},
): void {
  const writeDefect = dependencies.createDefect ?? createDefect;
  const getDefectUrl = dependencies.buildDefectUrl ?? buildDefectUrl;

  server.registerTool('validate_defect_ticket', {
    description:
      '校验并预览待创建的 Octane Defect 字段。不会写入 Octane；先调用它展示人工审核草稿。',
    inputSchema: defectTicketInputSchema,
  }, async (input) => {
    const fields = buildDefectFields(toDefectTicketDraft(input));
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ success: true, octane_fields: fields }, null, 2),
      }],
    };
  });

  server.registerTool('commit_defect_ticket', {
    description:
      '生产写入：创建真实的 Octane Defect。先调用 validate_defect_ticket 并展示草稿；'
      + '此工具会在写入前由 LibreChat 请求人工审批。',
    inputSchema: defectTicketInputSchema,
  }, async (input) => {
    const created = await writeDefect(toDefectTicketDraft(input));
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: true,
          defect_id: created.id,
          octane_url: getDefectUrl(created.id),
        }, null, 2),
      }],
    };
  });
}