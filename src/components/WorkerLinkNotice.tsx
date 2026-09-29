import { Link2Off } from "lucide-react";

export function WorkerLinkNotice({ name, manager = false }: { name?: string; manager?: boolean }) {
  return (
    <div className="mx-auto max-w-2xl rounded-xl border border-amber-200 bg-white p-6 shadow-sm" role="status">
      <div className="flex items-start gap-4">
        <div className="rounded-lg bg-amber-50 p-2 text-amber-700"><Link2Off className="h-5 w-5" /></div>
        <div>
          <h2 className="text-lg font-semibold text-slate-900">Your account is active</h2>
          <p className="mt-2 text-sm leading-relaxed text-slate-600">
            {manager ? <>
              {name ? `${name}, your` : "Your"} Project Manager login is ready, but it has not been connected to your Cutter record. Your own jobs and earnings will appear once the Owner selects that record in Users.
            </> : <>
              {name ? `${name}, your` : "Your"} sign-in is ready, but a matching production record has not been added under <strong>Workers</strong> yet. Jobs and earnings will appear once that record is available.
            </>}
          </p>
          <p className="mt-3 text-sm leading-relaxed text-slate-600">
            {manager ? <>
              Ask the Owner to open <strong>Users</strong>, select <strong>Manage</strong> on your Project Manager account,
              and choose your Cutter record under <strong>Also works in the factory</strong>. Keep this same email and password.
            </> : <>
              Ask the Owner to add you on the <strong>Workers</strong> page using the same full name as your sign-in account.
              There is no need to delete this login or its history.
            </>}
          </p>
        </div>
      </div>
    </div>
  );
}
