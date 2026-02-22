const express = require("express");
const cors = require("cors");
const axios = require("axios");
const { CookieJar } = require("tough-cookie");
const { wrapper } = require("axios-cookiejar-support");

const app = express();
app.use(cors({ origin: true }));


const jar = new CookieJar();

const client = wrapper(
    axios.create({
        jar,
        withCredentials: true,
        timeout: 20000,
        headers: {
            "User-Agent": "Mozilla/5.0",
            "Accept": "application/json, text/plain, */*",
            "Content-Type": "application/json;charset=UTF-8",
            "Origin": "https://finki.edupage.org",
            "Referer": "https://finki.edupage.org/timetable/"
        }
    })
);

const DAYS = {
    "Monday": 0,
    "Tuesday": 1,
    "Wednesday": 2,
    "Thursday": 3,
    "Friday": 4
};
const TARGET_CLASSES = [
    "2г-ССП",

    "3г-ПИТ",
    "4г-ПИТ",

    "3г-ИМБ",
    "4г-ИМБ",
    "2г-ИМБ",

    "3г-КН",

    "3г-СИИС",
    "4г-СИИС",

    "1y-SEIS",
    "2y-SEIS",
    "3y-SEIS",
    "4y-SEIS",
    "3г-КИ/Oст",
];

const EXCLUDED_CLASSES = ["1y-SEIS-Int"];

function classMatches(classText) {
    if (!classText) return false;

    const c = String(classText).trim();


    if (EXCLUDED_CLASSES.some(ex => c === ex || c.startsWith(ex))) return false;


    if (TARGET_CLASSES.includes(c)) return true;


    return TARGET_CLASSES.some(base => c.startsWith(base));
}



async function fetchTTViewerData(year = 2025) {
    // get session cookie
    await client.get("https://finki.edupage.org/timetable/");

    const url =
        "https://finki.edupage.org/timetable/server/ttviewer.js?__func=getTTViewerData";
    const payload = { __args: [null, year], __gsh: "00000000" };

    const res = await client.post(url, payload);
    return res.data;
}


async function fetchRegularTTData(ttNum) {
    const url =
        "https://finki.edupage.org/timetable/server/regulartt.js?__func=regularttGetData";
    const payload = { __args: [null, String(ttNum)], __gsh: "00000000" };

    const res = await client.post(url, payload);
    return res.data;
}


function pickDefaultTTNum(ttViewerData) {
    const n =
        ttViewerData?.r?.regular?.default_num ??
        ttViewerData?.regular?.default_num ??
        null;

    return n == null ? null : String(n);
}


function convertRegularToYourFormat(raw) {
    const root = raw?.r ?? raw;
    const tables = root?.dbiAccessorRes?.tables ?? [];


    if (!Array.isArray(tables)) {
        console.log("No tables at r.dbiAccessorRes.tables. keys:", Object.keys(root || {}));
        return { days: DAYS, data: [] };
    }

    const byId = new Map();
    for (const t of tables) {
        const tableId = t?.id || t?.def?.id;
        const rows = t?.data_rows;
        if (tableId && Array.isArray(rows)) byId.set(String(tableId), rows);
    }

    const cards = byId.get("cards") || [];
    const lessonsArr = byId.get("lessons") || [];
    const subjectsArr = byId.get("subjects") || [];
    const teachersArr = byId.get("teachers") || [];
    const classroomsArr = byId.get("classrooms") || [];
    const classesArr = byId.get("classes") || [];

    console.log("cards:", cards.length, "lessons:", lessonsArr.length, "subjects:", subjectsArr.length);

    const lessons = new Map(lessonsArr.map(x => [String(x.id), x]));
    const subjects = new Map(subjectsArr.map(x => [String(x.id), x]));
    const teachers = new Map(teachersArr.map(x => [String(x.id), x]));
    const classrooms = new Map(classroomsArr.map(x => [String(x.id), x]));
    const classes = new Map(classesArr.map(x => [String(x.id), x]));

    const items = [];

    for (const c of cards) {
        const periodNum = Number(c.period);
        if (!Number.isFinite(periodNum) || periodNum < 0) continue;
        const periodIndex = periodNum;


        const dayStr = String(c.days ?? "");
        const dayCode = dayStr.indexOf("1");
        if (dayCode < 0 || dayCode > 4) continue;

        const lesson = lessons.get(String(c.lessonid));
        if (!lesson) continue;

        const subj = subjects.get(String(lesson.subjectid));
        const fullName = subj?.name || "N/A";
        const eduShort = subj?.short || fullName || "N/A";
        const color = subj?.color || "#4b5563";


        const teacherId = Array.isArray(lesson.teacherids) ? lesson.teacherids[0] : null;
        const tObj = teacherId != null ? teachers.get(String(teacherId)) : null;
        const teacherName = tObj?.short || tObj?.name || "";


        const roomId = Array.isArray(c.classroomids) ? c.classroomids[0] : null;
        const rObj = roomId != null ? classrooms.get(String(roomId)) : null;
        const roomName = rObj?.short || rObj?.name || "";

        const classId = Array.isArray(lesson.classids) ? lesson.classids[0] : null;
        const clObj = classId != null ? classes.get(String(classId)) : null;
        const classText = clObj?.short || clObj?.name || "";


        if (!classMatches(classText)) continue;


        const duration = Number(lesson.durationperiods) || 1;
        for (let d = 0; d < duration; d++) {
            items.push({
                "Day code": dayCode,
                "Periods": [periodIndex + d],
                "Subject": fullName,
                "Short name": eduShort,
                "Teachers": teacherName || undefined,
                "Classrooms": roomName || "",
                "Classes": classText || undefined,
                "Color": color
            });
        }
    }

    return { days: DAYS, data: items };

}


function mergeByKey(items, keyFn) {
    const map = new Map();
    for (const it of items) {
        const k = keyFn(it);
        if (!map.has(k)) {
            map.set(k, { ...it, Periods: [...it.Periods] });
        } else {
            const cur = map.get(k);
            cur.Periods.push(...it.Periods);
            cur.Periods = Array.from(new Set(cur.Periods)).sort((a, b) => a - b);
        }
    }
    return Array.from(map.values());
}

function toNum(v) {
    if (typeof v === "number") return v;
    if (typeof v === "string" && v.trim() !== "") {
        const n = Number(v);
        return Number.isFinite(n) ? n : NaN;
    }
    return NaN;
}


app.get("/schedule", async (req, res) => {
    try {
        const year = Number(req.query.year ?? 2025);


        const viewer = await fetchTTViewerData(year);
        const defaultNum = pickDefaultTTNum(viewer);

        if (!defaultNum) {
            return res.json({ days: DAYS, data: [] });
        }


        const regular = await fetchRegularTTData(defaultNum);


        const converted = convertRegularToYourFormat(regular);
        res.json(converted);
    } catch (err) {
        res.status(500).json({
            error: "Failed to fetch timetable data",
            details: err?.response?.data ?? err.message
        });
    }
});

// Debug endpoints (helpful)
app.get("/debug/ttviewer", async (req, res) => {
    const year = Number(req.query.year ?? 2025);
    res.json(await fetchTTViewerData(year));
});

app.get("/debug/regulartt", async (req, res) => {
    const tt = String(req.query.tt ?? "27");
    res.json(await fetchRegularTTData(tt));
});

app.listen(3000, () => {
    console.log("✅ Backend running: http://localhost:3000/schedule?year=2025");
});
