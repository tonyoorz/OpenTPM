"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerDefectTicketTools = registerDefectTicketTools;
const zod_1 = require("zod");
const defect_js_1 = require("./defect.js");
const octane_js_1 = require("./octane.js");
const octaneReferenceSchema = zod_1.z.object({
    type: zod_1.z.string().min(1),
    id: zod_1.z.string().min(1),
});
const defectTicketInputSchema = {
    name: zod_1.z.string().min(1),
    description_html: zod_1.z.string().min(1),
    severity: octaneReferenceSchema,
    phase: octaneReferenceSchema,
    owner: octaneReferenceSchema,
    team: octaneReferenceSchema.optional(),
    problem_finder_team: octaneReferenceSchema.optional(),
    detected_in_release: octaneReferenceSchema.optional(),
    assigned_ecu: octaneReferenceSchema.optional(),
    lead_model: octaneReferenceSchema.optional(),
    software_version: zod_1.z.string().optional(),
    vin: zod_1.z.string().optional(),
    product_areas: zod_1.z.array(octaneReferenceSchema).optional(),
    custom_text_fields: zod_1.z.array(zod_1.z.object({
        field_name: zod_1.z.string().min(1),
        value: zod_1.z.string(),
    })).optional(),
    custom_reference_fields: zod_1.z.array(zod_1.z.object({
        field_name: zod_1.z.string().min(1),
        reference: octaneReferenceSchema,
    })).optional(),
    custom_multi_reference_fields: zod_1.z.array(zod_1.z.object({
        field_name: zod_1.z.string().min(1),
        references: zod_1.z.array(octaneReferenceSchema).min(1),
    })).optional(),
};
function toDefectTicketDraft(input) {
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
function registerDefectTicketTools(server, dependencies = {}) {
    const writeDefect = dependencies.createDefect ?? octane_js_1.createDefect;
    const getDefectUrl = dependencies.buildDefectUrl ?? octane_js_1.buildDefectUrl;
    server.registerTool('validate_defect_ticket', {
        description: '校验并预览待创建的 Octane Defect 字段。不会写入 Octane；先调用它展示人工审核草稿。',
        inputSchema: defectTicketInputSchema,
    }, async (input) => {
        const fields = (0, defect_js_1.buildDefectFields)(toDefectTicketDraft(input));
        return {
            content: [{
                    type: 'text',
                    text: JSON.stringify({ success: true, octane_fields: fields }, null, 2),
                }],
        };
    });
    server.registerTool('commit_defect_ticket', {
        description: '生产写入：创建真实的 Octane Defect。先调用 validate_defect_ticket 并展示草稿；'
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
