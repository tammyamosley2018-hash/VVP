// Send Client Message — Supabase Edge Function
//
// Holds the GHL Private Integration Token server-side. Uses the calling
// practitioner's own forwarded JWT for the Supabase client, so a
// practitioner can only ever look up (and message) their own clients --
// RLS enforces that, not a check we have to write and maintain here.

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
if (!SUPABASE_PUBLISHABLE_KEYS && !LEGACY_ANON_KEY) {
  throw new Error('Neither SUPABASE_PUBLISHABLE_KEYS nor SUPABASE_ANON_KEY is set');
}

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

    const reqBody = await req.json();
    const { client_id, channel, body } = reqBody;
    if (!client_id || !channel || !body) {
      return new Response(JSON.stringify({ error: 'Missing client_id, channel, or body' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    if (channel !== 'sms' && channel !== 'email') {
      return new Response(JSON.stringify({ error: 'channel must be "sms" or "email"' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const publishableKey = SUPABASE_PUBLISHABLE_KEYS?.['default'] || LEGACY_ANON_KEY;
    const supabase = createClient(SUPABASE_URL, publishableKey, {
      global: { headers: { Authorization: authHeader } },
    });

    // RLS scopes this to the calling practitioner's own clients only.
    const { data: client, error: clientErr } = await supabase
      .from('clients')
      .select('id, practitioner_id, full_name, email, ghl_contact_id')
      .eq('id', client_id)
      .single();

    if (clientErr || !client) {
      return new Response(JSON.stringify({ error: 'Client not found or not yours' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (!client.ghl_contact_id) {
      return new Response(
        JSON.stringify({ error: 'This client has no linked GHL contact yet -- nothing to message.' }),
        { status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const ghlBody: Record<string, unknown> = {
      type: channel === 'sms' ? 'SMS' : 'Email',
      contactId: client.ghl_contact_id,
      locationId: GHL_LOCATION_ID,
    };
    if (channel === 'sms') {
      ghlBody.message = body;
    } else {
      ghlBody.subject = 'A message from your VVP practitioner';
      ghlBody.html = body;
      ghlBody.emailTo = client.email;
    }

    const ghlRes = await fetch('https://services.leadconnectorhq.com/conversations/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${GHL_PIT_TOKEN}`,
        Version: '2021-07-28',
      },
      body: JSON.stringify(ghlBody),
    });

    if (!ghlRes.ok) {
      const errText = await ghlRes.text();
      return new Response(JSON.stringify({ error: 'GHL send failed: ' + errText }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { error: insertErr } = await supabase.from('client_messages').insert({
      client_id: client.id,
      practitioner_id: client.practitioner_id,
      direction: 'outbound',
      channel,
      body,
    });

    if (insertErr) {
      return new Response(
        JSON.stringify({ error: 'Sent via GHL, but failed to save locally: ' + insertErr.message }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
