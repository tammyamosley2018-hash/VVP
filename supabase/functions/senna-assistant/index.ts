// Senna AI Assistant — Supabase Edge Function
//
// Holds the Anthropic API key server-side. The browser never sees it.
// Uses the CALLING PRACTITIONER'S OWN JWT (forwarded from the frontend's
// supabase.functions.invoke() call) to create its Supabase client, so
// every query below runs under the same Row Level Security a browser
// request would — a practitioner can never pull another practitioner's
// client data through this function, by construction, not by an extra
// permission check we'd have to remember to write correctly.

import { createClient } from 'npm:@supabase/supabase-js@2';

const MANUAL_URL = 'https://tammyamosley2018-hash.github.io/VVP/assets/data/vvp-manual-content.txt';
const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY');
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_PUBLISHABLE_KEY = JSON.parse(Deno.env.get('SUPABASE_PUBLISHABLE_KEYS')!)['default'];

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

    const { message, client_id } = await req.json();
    if (!message || typeof message !== 'string') {
      return new Response(JSON.stringify({ error: 'Missing message' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
      global: { headers: { Authorization: authHeader } },
    });

    const manualText = await fetch(MANUAL_URL).then((r) => r.text());

    let clientContext = '';
    if (client_id) {
      const [{ data: client }, { data: submissions }, { data: results }] = await Promise.all([
        supabase.from('clients').select('full_name, created_at').eq('id', client_id).single(),
        supabase.from('client_intake_submissions').select('form_data, submitted_at').eq('client_id', client_id).order('submitted_at', { ascending: false }),
        supabase.from('client_results').select('result_data, created_at').eq('client_id', client_id).order('created_at', { ascending: false }),
      ]);

      if (!client) {
        clientContext = 'The requested client was not found, or does not belong to the requesting practitioner.';
      } else {
        clientContext =
          `CLIENT RECORD\nName: ${client.full_name}\nClient since: ${client.created_at}\n\n` +
          `Intake submissions (${(submissions || []).length}):\n${JSON.stringify(submissions, null, 2)}\n\n` +
          `Recorded results (${(results || []).length}):\n${JSON.stringify(results, null, 2)}`;
      }
    }

    const systemPrompt =
      `You are Senna, the AI assistant inside the Vibrational Virtue Practitioner (VVP) portal. ` +
      `You help VVP practitioners look up training/protocol guidance and summarize their own clients' records. ` +
      `Follow VVP's scope-safe language rules at all times: never diagnose, never prescribe medical treatment, ` +
      `never claim to cure, never represent uncertainty as certainty, and recommend referral to licensed care for ` +
      `anything resembling a red flag. Be concise and practical.\n\n` +
      `--- VVP VOLUME I MANUAL CONTENT ---\n${manualText}` +
      (clientContext ? `\n\n--- CURRENT CLIENT CONTEXT ---\n${clientContext}` : '');

    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY!,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: 'user', content: message }],
      }),
    });

    if (!anthropicRes.ok) {
      const errText = await anthropicRes.text();
      return new Response(JSON.stringify({ error: 'Assistant request failed: ' + errText }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const anthropicJson = await anthropicRes.json();
    const reply = anthropicJson.content?.[0]?.text || '(No response text)';

    return new Response(JSON.stringify({ reply }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
