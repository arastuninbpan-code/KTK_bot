import {runtime} from "../lib/runtime.mjs";

// Раз в минуту: сверить расписание с прошлой версией, разослать уведомления и напоминания.
export default async () => {
  try {
    const r = await runtime().cycle();
    console.log(JSON.stringify(r));
  } catch (e) {
    console.error(String(e?.message || e));
  }
};

export const config = {schedule: "* * * * *"};
