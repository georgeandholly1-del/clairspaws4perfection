
import type { APIRoute } from "astro";
import { supabase } from "../../lib/supabase";

export const prerender = false;

export const GET: APIRoute = async () => {
    const { error } = await supabase
        .from("appointments")
        .select("id")
        .limit(1);

    if (error) {
        console.error("Supabase connection failed:", error.message);

        return new Response(
            JSON.stringify({ ok: false, message: "Database connection failed" }),
            { status: 500 }
        );
    }

    return new Response(
        JSON.stringify({ ok: true, database: "connected" }),
        { status: 200 }
    );
};
