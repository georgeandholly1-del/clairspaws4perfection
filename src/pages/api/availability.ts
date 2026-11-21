
import type { APIRoute } from "astro";
import { supabase } from "../../lib/supabase";

export const prerender = false;

const APPOINTMENT_DURATION = 60; // Temporary default: 60 minutes

export const GET: APIRoute = async ({ request }) => {
    const url = new URL(request.url);
    const date = url.searchParams.get("date");

    // Validate the requested date
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return Response.json(
            { error: "A valid date is required." },
            { status: 400 }
        );
    }

    const parsedDate = new Date(`${date}T00:00:00Z`);

    if (
        Number.isNaN(parsedDate.getTime()) ||
        parsedDate.toISOString().slice(0, 10) !== date
    ) {
        return Response.json(
            { error: "Invalid date." },
            { status: 400 }
        );
    }

    // Determine opening hours
    const day = parsedDate.getUTCDay();

    let start: number;
    let end: number;

    if (day >= 1 && day <= 4) {
        start = 16;
        end = 20;
    } else if (day === 6) {
        start = 9;
        end = 18;
    } else {
        return Response.json({ slots: [] });
    }

    // Retrieve existing active appointments
    const { data, error } = await supabase
        .from("appointments")
        .select("appointment_time, duration_minutes")
        .eq("appointment_date", date)
        .in("booking_status", ["pending", "confirmed"]);

    if (error) {
        console.error("Availability lookup failed:", error.message);

        return Response.json(
            { error: "Unable to check availability." },
            { status: 500 }
        );
    }

    const appointments = data ?? [];

    const slots = [];

    for (let hour = start; hour < end; hour++) {
        const slotStart = hour * 60;
        const slotEnd = slotStart + APPOINTMENT_DURATION;

        const available = !appointments.some((appointment) => {
            const [hours, minutes] = appointment.appointment_time
                .split(":")
                .map(Number);

            const existingStart = hours * 60 + minutes;
            const existingEnd =
                existingStart + appointment.duration_minutes;

            // Check whether the two appointments overlap
            return (
                slotStart < existingEnd &&
                slotEnd > existingStart
            );
        });

        slots.push({
            time: `${String(hour).padStart(2, "0")}:00`,
            available
        });
    }

    return Response.json(
        { slots },
        {
            headers: {
                "Cache-Control": "no-store"
            }
        }
    );
};
