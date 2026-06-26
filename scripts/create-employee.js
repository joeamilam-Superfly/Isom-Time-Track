// One-time helper to create an employee record and assign them a role at
// one company, since there's no public signup flow by design.
//
// Usage:
//   SUPABASE_URL=... SUPABASE_SERVICE_KEY=... node scripts/create-employee.js \
//     --first "Mitzi" --last "Isom" --phone "8645551234" --pin 4821 \
//     --company "Isom Electric" --role admin
//
// To make someone a super admin (can act as admin at every company,
// including ones with no explicit role row), add --superadmin true.
// A super admin still needs --company/--role for at least one company
// if you want them to also have a specific role there; otherwise they'll
// just show up as admin everywhere by default.
//
// To add a SECOND company role to an employee who already exists, run
// this again with the same phone number, a different --company, and
// --role - it will find the existing employee by phone and just add the
// new company role row, rather than creating a duplicate employee.
//
// Run this locally (not in a Netlify Function) after running sql/schema.sql
// in your Supabase project.

const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcryptjs');

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {};
  for (let i = 0; i < args.length; i += 2) {
    out[args[i].replace(/^--/, '')] = args[i + 1];
  }
  return out;
}

function normalizePhone(raw) {
  const digits = (raw || '').replace(/\D/g, '');
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;
  throw new Error(`Could not normalize phone number: ${raw}`);
}

async function main() {
  const args = parseArgs();

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    console.error('SUPABASE_URL and SUPABASE_SERVICE_KEY must be set in the environment');
    process.exit(1);
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  if (!args.phone) {
    console.error('Missing required --phone argument');
    process.exit(1);
  }
  const phone = normalizePhone(args.phone);

  // Look up an existing employee by phone first - this lets the same
  // command pattern both create new people AND add an additional company
  // role to someone who already exists.
  const { data: existingEmployee } = await supabase
    .from('employees')
    .select('id, first_name, last_name')
    .eq('phone', phone)
    .maybeSingle();

  let employeeId;

  if (existingEmployee) {
    employeeId = existingEmployee.id;
    console.log(`Found existing employee: ${existingEmployee.first_name} ${existingEmployee.last_name} (${employeeId})`);

    if (args.superadmin === 'true') {
      const { error: superAdminError } = await supabase
        .from('employees')
        .update({ super_admin: true })
        .eq('id', employeeId);
      if (superAdminError) {
        console.error('Failed to set super_admin:', superAdminError.message);
        process.exit(1);
      }
      console.log('Marked as super admin.');
    }
  } else {
    const required = ['first', 'last', 'pin'];
    for (const key of required) {
      if (!args[key]) {
        console.error(`Missing required --${key} argument (needed to create a new employee)`);
        process.exit(1);
      }
    }

    const pinHash = bcrypt.hashSync(String(args.pin), 10);

    const { data: created, error } = await supabase
      .from('employees')
      .insert({
        first_name: args.first,
        last_name: args.last,
        phone,
        email: args.email || null,
        pin_hash: pinHash,
        super_admin: args.superadmin === 'true',
      })
      .select()
      .single();

    if (error) {
      console.error('Failed to create employee:', error.message);
      process.exit(1);
    }

    employeeId = created.id;
    console.log('Created new employee:', JSON.stringify(created, null, 2));
  }

  // If a company was specified, add (or update) their role there.
  if (args.company) {
    const role = args.role || 'employee';
    if (!['employee', 'foreman', 'admin'].includes(role)) {
      console.error('--role must be one of: employee, foreman, admin');
      process.exit(1);
    }

    const { data: company, error: companyError } = await supabase
      .from('companies')
      .select('id')
      .eq('name', args.company)
      .maybeSingle();

    if (companyError || !company) {
      console.error(`Could not find a company named "${args.company}". Check spelling/capitalization against the companies table.`);
      process.exit(1);
    }

    let foremanId = null;
    if (args.foreman) {
      const foremanPhone = normalizePhone(args.foreman);
      const { data: foremanEmployee } = await supabase
        .from('employees')
        .select('id')
        .eq('phone', foremanPhone)
        .maybeSingle();
      if (!foremanEmployee) {
        console.error(`Could not find an employee with phone ${args.foreman} to use as foreman`);
        process.exit(1);
      }
      // sanity check: the foreman should also have a role at this same company
      const { data: foremanRole } = await supabase
        .from('employee_company_roles')
        .select('id')
        .eq('employee_id', foremanEmployee.id)
        .eq('company_id', company.id)
        .maybeSingle();
      if (!foremanRole) {
        console.error(`That foreman does not have a role at ${args.company} yet. Add them to this company first.`);
        process.exit(1);
      }
      foremanId = foremanEmployee.id;
    }

    const { data: roleRow, error: roleError } = await supabase
      .from('employee_company_roles')
      .upsert({
        employee_id: employeeId,
        company_id: company.id,
        role,
        foreman_id: foremanId,
        active: true,
      }, { onConflict: 'employee_id,company_id' })
      .select()
      .single();

    if (roleError) {
      console.error('Failed to assign company role:', roleError.message);
      process.exit(1);
    }

    console.log(`Assigned role "${role}" at "${args.company}":`, JSON.stringify(roleRow, null, 2));
  } else if (!existingEmployee) {
    console.log('No --company specified. This employee has no company role yet and will not be able to do anything until one is assigned (run this script again with --company).');
  }
}

main();
