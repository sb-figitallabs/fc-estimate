-- FC handover package add-on schema
-- Apply this after restoring the base FC handoff clean database.

create schema if not exists fc;

create table if not exists fc.package_master (
    tariff_code text not null,
    package_code text not null,
    package_name text not null,
    canonical_package_name text,
    normalized_package_name text,
    tariff_name text,
    package_type text,
    department_code text,
    department_name text,
    company_code text,
    package_amount numeric,
    package_atl_amount numeric,
    pre_days integer,
    post_days integer,
    package_duration integer,
    is_active boolean,
    effective_from date,
    effective_to date,
    equservice_code text,
    surgery_code text,
    is_edit_days_in_pkg_billing boolean,
    source_pack text not null,
    source_version text,
    payor_bucket text not null,
    documentation_available boolean,
    documentation_status text,
    has_tariff boolean,
    tariff_source text,
    tariff_information text,
    has_inclusions boolean,
    inclusion_source text,
    inclusions_text text,
    has_exclusions boolean,
    exclusion_source text,
    exclusions_text text,
    documentation_family text,
    documentation_confidence text,
    documentation_notes text,
    matched_room_category text,
    json_package_code text,
    json_package_id text,
    json_serial_no text,
    json_procedure_name text,
    json_system text,
    json_category text,
    package_specific_reference_codes text,
    shared_terms_apply boolean,
    non_admissible_expense_rules_apply boolean,
    agreement_general_clauses text,
    agreement_surgical_guidelines text,
    fc_template_available boolean,
    fc_runtime_ready boolean,
    fc_template_status text,
    fc_mapping_confidence text,
    fc_match_method text,
    fc_template_package_code text,
    fc_template_primary_package_name text,
    fc_template_package_names text,
    fc_tariff_code text,
    fc_tariff_name text,
    fc_case_count_total bigint,
    fc_template_action text,
    fc_runtime_behavior text,
    fc_notes text,
    fc_alternative_candidates_jsonb jsonb not null default '[]'::jsonb,
    can_generate_estimate boolean,
    can_generate_label text,
    runtime_status text,
    readiness_score numeric,
    primary_blocker text,
    secondary_gaps text,
    missing_items text,
    developer_action text,
    in_review_queue boolean,
    warning_reason text,
    primary key (tariff_code, package_code)
);

create index if not exists fc_package_master_name_idx
    on fc.package_master (lower(package_name));
create index if not exists fc_package_master_canonical_name_idx
    on fc.package_master (lower(coalesce(canonical_package_name, '')));
create index if not exists fc_package_master_payor_idx
    on fc.package_master (payor_bucket, tariff_code);
create index if not exists fc_package_master_fc_pkg_idx
    on fc.package_master (fc_template_package_code);
create index if not exists fc_package_master_runtime_idx
    on fc.package_master (runtime_status, can_generate_estimate);

create table if not exists fc.package_room_rates (
    tariff_code text not null,
    package_code text not null,
    ordinal integer not null,
    room_category_code text,
    room_category_label text,
    amount numeric,
    source_field text,
    source_note text,
    primary key (tariff_code, package_code, ordinal),
    foreign key (tariff_code, package_code)
        references fc.package_master(tariff_code, package_code)
        on delete cascade
);

create table if not exists fc.package_alias (
    tariff_code text not null,
    package_code text not null,
    package_name text,
    alias_text text not null,
    alias_type text not null default '',
    alias_source text,
    alias_confidence text,
    normalized_alias_text text,
    source_code text,
    source_record_id text,
    notes text,
    primary key (tariff_code, package_code, alias_text, alias_type),
    foreign key (tariff_code, package_code)
        references fc.package_master(tariff_code, package_code)
        on delete cascade
);

create index if not exists fc_package_alias_norm_idx
    on fc.package_alias (normalized_alias_text);

create table if not exists fc.package_organization_applicability (
    organization_cd text not null default '',
    organization_name text,
    tariff_code text not null,
    tariff_name text,
    package_code text not null,
    package_name text,
    payor_bucket text not null,
    applicability_source text not null,
    primary key (organization_cd, tariff_code, package_code),
    foreign key (tariff_code, package_code)
        references fc.package_master(tariff_code, package_code)
        on delete cascade
);

create index if not exists fc_package_org_applicability_lookup_idx
    on fc.package_organization_applicability (organization_cd, tariff_code);

create or replace view fc.v_package_runtime_lookup as
with alias_summary as (
    select
        tariff_code,
        package_code,
        jsonb_agg(
            jsonb_build_object(
                'alias_text', alias_text,
                'alias_type', nullif(alias_type, ''),
                'alias_source', alias_source,
                'alias_confidence', alias_confidence
            )
            order by normalized_alias_text, alias_text
        ) as aliases_jsonb
    from fc.package_alias
    group by tariff_code, package_code
),
room_rate_summary as (
    select
        tariff_code,
        package_code,
        jsonb_agg(
            jsonb_build_object(
                'ordinal', ordinal,
                'room_category_code', room_category_code,
                'room_category_label', room_category_label,
                'amount', amount,
                'source_field', source_field,
                'source_note', source_note
            )
            order by ordinal
        ) as room_rates_jsonb
    from fc.package_room_rates
    group by tariff_code, package_code
)
select
    nullif(app.organization_cd, '') as organization_cd,
    app.organization_name,
    pm.tariff_code,
    coalesce(app.tariff_name, pm.tariff_name) as tariff_name,
    pm.package_code,
    pm.package_name,
    pm.canonical_package_name,
    pm.normalized_package_name,
    pm.package_type,
    pm.department_code,
    pm.department_name,
    pm.company_code,
    pm.package_amount,
    pm.package_atl_amount,
    pm.pre_days,
    pm.post_days,
    pm.package_duration,
    pm.is_active,
    pm.effective_from,
    pm.effective_to,
    pm.equservice_code,
    pm.surgery_code,
    pm.is_edit_days_in_pkg_billing,
    pm.source_pack,
    pm.source_version,
    pm.payor_bucket,
    app.applicability_source,
    pm.documentation_available,
    pm.documentation_status,
    pm.has_tariff,
    pm.tariff_source,
    pm.tariff_information,
    pm.has_inclusions,
    pm.inclusion_source,
    pm.inclusions_text,
    pm.has_exclusions,
    pm.exclusion_source,
    pm.exclusions_text,
    pm.documentation_family,
    pm.documentation_confidence,
    pm.documentation_notes,
    pm.matched_room_category,
    pm.json_package_code,
    pm.json_package_id,
    pm.json_serial_no,
    pm.json_procedure_name,
    pm.json_system,
    pm.json_category,
    pm.package_specific_reference_codes,
    pm.shared_terms_apply,
    pm.non_admissible_expense_rules_apply,
    pm.agreement_general_clauses,
    pm.agreement_surgical_guidelines,
    coalesce(rr.room_rates_jsonb, '[]'::jsonb) as room_rates_jsonb,
    pm.fc_template_available,
    pm.fc_runtime_ready,
    pm.fc_template_status,
    pm.fc_mapping_confidence,
    pm.fc_match_method,
    pm.fc_template_package_code,
    pm.fc_template_primary_package_name,
    pm.fc_template_package_names,
    pm.fc_tariff_code,
    pm.fc_tariff_name,
    pm.fc_case_count_total,
    pm.fc_template_action,
    pm.fc_runtime_behavior,
    pm.fc_notes,
    pm.fc_alternative_candidates_jsonb,
    pm.can_generate_estimate,
    pm.can_generate_label,
    pm.runtime_status,
    pm.readiness_score,
    pm.primary_blocker,
    pm.secondary_gaps,
    pm.missing_items,
    pm.developer_action,
    pm.in_review_queue,
    pm.warning_reason,
    coalesce(al.aliases_jsonb, '[]'::jsonb) as aliases_jsonb
from fc.package_master pm
join fc.package_organization_applicability app
  on app.tariff_code = pm.tariff_code
 and app.package_code = pm.package_code
left join room_rate_summary rr
  on rr.tariff_code = pm.tariff_code
 and rr.package_code = pm.package_code
left join alias_summary al
  on al.tariff_code = pm.tariff_code
 and al.package_code = pm.package_code;

create or replace view fc.v_package_case_history as
select
    runtime.organization_cd,
    runtime.organization_name,
    runtime.tariff_code,
    runtime.package_code,
    runtime.package_name,
    count(distinct mt.admission_no) as admission_count,
    max(mt.date_of_admission) as latest_admission_at,
    min(mt.package_amount) filter (where mt.package_amount is not null) as min_observed_package_amount,
    max(mt.package_amount) filter (where mt.package_amount is not null) as max_observed_package_amount,
    jsonb_agg(
        distinct jsonb_build_object(
            'admission_no', mt.admission_no,
            'date_of_admission', mt.date_of_admission,
            'doctor_name', mt.doctor_name,
            'department_name', mt.department_name,
            'package_amount', mt.package_amount
        )
    ) filter (where mt.admission_no is not null) as sample_admissions_jsonb
from fc.v_package_runtime_lookup runtime
left join mart.main_table mt
  on upper(trim(coalesce(mt.tariff_code, ''))) = upper(trim(coalesce(runtime.tariff_code, '')))
 and upper(trim(coalesce(mt.package_code, ''))) = upper(trim(coalesce(runtime.package_code, '')))
 and (
     runtime.organization_cd is null
     or upper(trim(coalesce(mt.organization_cd, ''))) = upper(trim(coalesce(runtime.organization_cd, '')))
 )
group by
    runtime.organization_cd,
    runtime.organization_name,
    runtime.tariff_code,
    runtime.package_code,
    runtime.package_name;
