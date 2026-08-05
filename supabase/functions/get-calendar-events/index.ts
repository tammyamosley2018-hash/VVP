// Get Calendar Events — Supabase Edge Function
//
// Holds the GHL Private Integration Token server-side (reuses the same
// GHL_PIT_TOKEN secret as send-client-message). Uses the calling
// practitioner's own JWT to look up their OWN calendar_id only -- RLS
// scopes this the same way it scopes everything else, so a practitioner
// can only ever see their own schedule.

import { createClient } from 'npm:@supabase/supabase-js@2';

const GHL_LOCATION_ID = 'C3WOZSxFEB49IHaRsiiZ';
const GHL_PIT_TOKEN = Deno.env.get('GHL_PIT_TOKEN');
const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
if (!GHL_PIT_TOKEN) throw new Error('GHL_PIT_TOKEN is required');
if (!SUPABASE_URL) throw new Error('SUPABASE_URL is required');

const SUPABASE_PUBLISHABLE_KEYS_RAW = Deno.env.get('SUPABASE_PUBLISHABLE_KEYS');
const LEGACY_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY');
const SUPABASE_PUBLISHABLE_KEYS = SUPABASE_PUBLISHABLE_KEYS_RAW
  ? JSON.parse(SUPABASE_PUBLISHABLE_KEYS_RAW)
  : null;
const PROJECT_API_KEY = SUPABASE_PUBLISHABLE_KEYS?.['default'] || LEGACY_ANON_KEY;
if (!PROJECT_API_KEY) throw new Error('Neither SUPABASE_PUBLISHABLE_KEYS nor SUPABASE_ANON_KEY is set');

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Missing Authorization header' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabase = createClient(SUPABASE_URL, PROJECT_API_KEY, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: userData } = await supabase.auth.getUser();
    if (!userData?.user) {
      return new Response(JSON.stringify({ error: 'Invalid session' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { data: prac } = await supabase
      .from('practitioners')
      .select('calendar_id')
      .eq('user_id', userData.user.id)
      .single();

    if (!prac || !prac.calendar_id) {
      return new Response(JSON.stringify({ events: [], calendarConfigured: false }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const now = Date.now();
    const in30Days = now + 30 * 24 * 60 * 60 * 1000;
    const url =
      `https://services.leadconnectorhq.com/calendars/events?calendarId=${prac.calendar_id}` +
      `&locationId=${GHL_LOCATION_ID}&startTime=${now}&endTime=${in30Days}`;

    const ghlRes = await fetch(url, {
      headers: {
        Authorization: `Bearer ${GHL_PIT_TOKEN}`,
        Version: '2021-07-28',
      },
    });

    if (!ghlRes.ok) {
      const errText = await ghlRes.text();
      return new Response(JSON.stringify({ error: 'GHL calendar fetch failed: ' + errText }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const ghlJson = await ghlRes.json();

    return new Response(
      JSON.stringify({ events: ghlJson.events || [], calendarConfigured: true }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
