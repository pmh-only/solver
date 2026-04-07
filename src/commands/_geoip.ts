import { request } from 'node:https'
import { isIP } from 'node:net'

const GEOIP_TIMEOUT = 5000

export interface GeoIpResult {
  ip: string
  city?: string
  region?: string
  country?: string
  countryCode?: string
  continent?: string
  latitude?: number
  longitude?: number
  timezone?: string
  asn?: string
  org?: string
  isp?: string
}

interface GeoIpApiResponse {
  success?: boolean
  ip?: string
  city?: string
  region?: string
  country?: string
  country_code?: string
  continent?: string
  latitude?: number
  longitude?: number
  timezone?: { id?: string }
  connection?: { asn?: number; org?: string; isp?: string }
  message?: string
}

async function getJson(url: string): Promise<GeoIpApiResponse> {
  return await new Promise((resolve, reject) => {
    const req = request(url, { timeout: GEOIP_TIMEOUT }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => {
        try {
          const body = Buffer.concat(chunks).toString('utf8')
          resolve(JSON.parse(body) as GeoIpApiResponse)
        } catch (error) {
          reject(error)
        }
      })
    })

    req.on('timeout', () => req.destroy(new Error('geo timeout')))
    req.on('error', reject)
    req.end()
  })
}

async function lookup(ip: string): Promise<GeoIpResult> {
  const query = ip.trim()
  if (!isIP(query)) throw new Error('bad ip')

  const data = await getJson(`https://ipwho.is/${encodeURIComponent(query)}`)
  if (data.success === false) throw new Error(data.message ?? 'geo err')

  return {
    ip: data.ip ?? query,
    city: data.city,
    region: data.region,
    country: data.country,
    countryCode: data.country_code,
    continent: data.continent,
    latitude: data.latitude,
    longitude: data.longitude,
    timezone: data.timezone?.id,
    asn: data.connection?.asn ? `AS${data.connection.asn}` : undefined,
    org: data.connection?.org,
    isp: data.connection?.isp
  }
}

export const geoIpClient = {
  lookup
}
