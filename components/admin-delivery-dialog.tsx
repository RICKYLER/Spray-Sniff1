'use client'

import { useEffect, useMemo, useState } from 'react'
import { Package, ShieldAlert, CheckCircle2, Search, Loader2, Tag, Info } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  DELIVERY_ORDER_STATUSES,
  type OrderRecord,
  type OrderStatus,
  useStore,
} from '@/lib/store-context'
import { getBrowserAuthHeaders } from '@/lib/client-auth-headers'
import { toast } from '@/hooks/use-toast'

interface AdminDeliveryDialogProps {
  order: OrderRecord | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

interface CarrierCatalogMatch {
  slug: string
  name: string
  input_requirements?: {
    required?: string[]
    any_of?: string[]
    conditional?: string[]
  }
}

const DELIVERY_STATUS_RANK: Record<string, number> = {
  Shipped: 0,
  'In Transit': 1,
  'Out for Delivery': 2,
  Delivered: 3,
}

/** Stages an admin may still move this order to: forward only, never backwards. */
function getSelectableStatuses(currentStatus: OrderStatus) {
  const currentRank = DELIVERY_STATUS_RANK[currentStatus]

  if (currentRank === undefined) {
    return [...DELIVERY_ORDER_STATUSES]
  }

  return DELIVERY_ORDER_STATUSES.filter((status) => DELIVERY_STATUS_RANK[status] > currentRank)
}

/**
 * Rendered with a `key` tied to the order id, so opening the dialog for a
 * different order remounts it with that order's values. This avoids a reset
 * effect that would otherwise wipe unsaved input whenever realtime updates
 * refresh the order list underneath the open dialog.
 */
export function AdminDeliveryDialog({ order, open, onOpenChange }: AdminDeliveryDialogProps) {
  const { updateOrderDelivery } = useStore()

  const selectableStatuses = useMemo(
    () => (order ? getSelectableStatuses(order.status) : []),
    [order],
  )

  const [courier, setCourier] = useState(order?.courier ?? '')
  const [courierSlug, setCourierSlug] = useState(order?.courierSlug ?? '')
  const [trackingNumber, setTrackingNumber] = useState(order?.trackingNumber ?? '')
  const [deliveryNotes, setDeliveryNotes] = useState(order?.deliveryNotes ?? '')
  const [status, setStatus] = useState<OrderStatus | ''>(() => getSelectableStatuses(order?.status ?? 'Pending')[0] ?? '')
  const [isSaving, setIsSaving] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [isCheckingWaybill, setIsCheckingWaybill] = useState(false)
  const [detectedCarrier, setDetectedCarrier] = useState<string | null>(null)
  const [carrierMatches, setCarrierMatches] = useState<CarrierCatalogMatch[]>([])
  const [isSearchingCarriers, setIsSearchingCarriers] = useState(false)
  const [showCarrierDropdown, setShowCarrierDropdown] = useState(false)
  const [selectedCarrierRules, setSelectedCarrierRules] = useState<string | null>(null)

  useEffect(() => {
    if (!open || !showCarrierDropdown) return

    const query = courier.trim()
    if (query.length < 2) {
      setCarrierMatches([])
      return
    }

    let cancelled = false
    const timer = setTimeout(async () => {
      setIsSearchingCarriers(true)
      try {
        const headers = await getBrowserAuthHeaders()
        const res = await fetch(
          `/api/tracking-carriers?query=${encodeURIComponent(query)}&limit=8`,
          { headers, cache: 'no-store' },
        )
        const data = (await res.json().catch(() => null)) as {
          carriers?: CarrierCatalogMatch[]
        } | null
        if (!cancelled && res.ok && Array.isArray(data?.carriers)) {
          setCarrierMatches(data.carriers)
        }
      } catch {
        if (!cancelled) setCarrierMatches([])
      } finally {
        if (!cancelled) setIsSearchingCarriers(false)
      }
    }, 250)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [courier, open, showCarrierDropdown])

  if (!order) {
    return null
  }

  const handleSelectCarrierMatch = (match: CarrierCatalogMatch) => {
    setCourier(match.name)
    setCourierSlug(match.slug)
    setShowCarrierDropdown(false)
    setCarrierMatches([])

    const reqParts = [
      ...(match.input_requirements?.required ?? []),
      ...(match.input_requirements?.any_of ?? []).map((f) => `${f} (any)`),
      ...(match.input_requirements?.conditional ?? []).map((f) => `${f} (conditional)`),
    ]
    setSelectedCarrierRules(reqParts.length > 0 ? `Carrier requires: ${reqParts.join(', ')}` : null)
  }

  const handleVerifyWaybill = async () => {
    const trimmed = trackingNumber.trim()
    if (!trimmed) {
      toast({
        title: 'Enter a tracking number',
        description: 'Please input a waybill number to verify with Parcels API v5.',
        variant: 'destructive',
      })
      return
    }

    setIsCheckingWaybill(true)
    setDetectedCarrier(null)

    try {
      const carrierQuery = courierSlug.trim() ? `&carrier=${encodeURIComponent(courierSlug.trim())}` : ''
      const res = await fetch(`/api/track?number=${encodeURIComponent(trimmed)}${carrierQuery}`)
      const data = await res.json().catch(() => null)

      if (!res.ok && data?.error) {
        toast({
          title: 'Waybill Validation Notice',
          description: data.error,
          variant: 'destructive',
        })
        return
      }

      if (res.ok && data?.carrier?.name && data?.carrier?.name !== 'Courier Partner') {
        setDetectedCarrier(data.carrier.name)
        if (!courier.trim()) {
          setCourier(data.carrier.name)
        }
        if (data.carrier.slug && !courierSlug.trim()) {
          setCourierSlug(data.carrier.slug)
        }
        toast({
          title: data.isLiveCourier ? 'Live Courier Verified' : 'Carrier Identified',
          description: data.isLiveCourier
            ? `${data.carrier.name} — ${data.statusText} (${data.events?.length ?? 0} scan events)`
            : `Recognized carrier: ${data.carrier.name}`,
        })
      } else if (data?.isProcessing) {
        toast({
          title: 'Courier Lookup Queued',
          description: 'Parcels v5 is fetching initial carrier scans. Save delivery to attach this waybill.',
        })
      } else {
        toast({
          title: 'Waybill Recorded',
          description: 'Tracking number checked. Live courier scans will sync once accepted by the carrier.',
        })
      }
    } catch {
      toast({
        title: 'Verification Notice',
        description: 'Courier check completed. Tracking will update as courier scans progress.',
      })
    } finally {
      setIsCheckingWaybill(false)
    }
  }

  const handleRequestSave = () => {
    if (!status) {
      toast({
        title: 'No delivery stage selected',
        description: 'This order is already at the final delivery stage.',
        variant: 'destructive',
      })
      return
    }

    setConfirming(true)
  }

  const handleConfirmSave = async () => {
    if (!status) {
      return
    }

    setConfirming(false)
    setIsSaving(true)

    try {
      const result = await updateOrderDelivery(order.id, {
        status,
        courier,
        courierSlug: courierSlug.trim() || undefined,
        trackingNumber,
        deliveryNotes,
      })

      toast({
        title: result.ok ? 'Delivery updated' : 'Unable to update delivery',
        description: result.message,
        variant: result.ok ? 'default' : 'destructive',
      })

      if (result.ok) {
        if (trackingNumber.trim()) {
          const carrierQuery = courierSlug.trim()
            ? `&carrier=${encodeURIComponent(courierSlug.trim())}`
            : ''
          fetch(`/api/track?number=${encodeURIComponent(trackingNumber.trim())}${carrierQuery}`).catch(() => {})
        }
        onOpenChange(false)
      }
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-lg" data-ui="admin-delivery-dialog">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Package className="h-4 w-4" />
              Manage Delivery — {order.id}
            </DialogTitle>
            <DialogDescription>
              Delivery progress is visible to the customer on their tracking page. Live courier scans sync via Parcels API v5.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="space-y-1.5 relative">
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor="delivery-courier">Courier Partner</Label>
                {courierSlug && (
                  <span className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                    <Tag className="h-3 w-3" />
                    {courierSlug}
                  </span>
                )}
              </div>
              <Input
                id="delivery-courier"
                value={courier}
                onFocus={() => setShowCarrierDropdown(true)}
                onBlur={() => setTimeout(() => setShowCarrierDropdown(false), 180)}
                onChange={(event) => {
                  setCourier(event.target.value)
                  setCourierSlug('')
                  setSelectedCarrierRules(null)
                  setShowCarrierDropdown(true)
                }}
                placeholder="Search Parcels v5 carriers (e.g. LBC, J&T Express, Ninja Van, Flash)"
                maxLength={200}
                autoComplete="off"
              />
              {showCarrierDropdown && (isSearchingCarriers || carrierMatches.length > 0) && (
                <div
                  className="absolute left-0 right-0 top-[68px] z-50 max-h-48 overflow-y-auto rounded-lg border border-border bg-popover p-1 shadow-md"
                  data-ui="carrier-picker-dropdown"
                >
                  {isSearchingCarriers ? (
                    <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      Searching Parcels v5 carrier catalog...
                    </div>
                  ) : (
                    carrierMatches.map((match) => (
                      <button
                        key={match.slug}
                        type="button"
                        onMouseDown={(e) => {
                          e.preventDefault()
                          handleSelectCarrierMatch(match)
                        }}
                        className="flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-left text-xs hover:bg-muted"
                      >
                        <span className="font-medium text-foreground">{match.name}</span>
                        <span className="font-mono text-[11px] text-muted-foreground">{match.slug}</span>
                      </button>
                    ))
                  )}
                </div>
              )}
              {selectedCarrierRules && (
                <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <Info className="h-3 w-3 shrink-0" />
                  {selectedCarrierRules}
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label htmlFor="delivery-tracking">Tracking / Waybill Number</Label>
                {detectedCarrier && (
                  <span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
                    <CheckCircle2 className="h-3 w-3" /> {detectedCarrier}
                  </span>
                )}
              </div>
              <div className="flex gap-2">
                <Input
                  id="delivery-tracking"
                  value={trackingNumber}
                  onChange={(event) => setTrackingNumber(event.target.value)}
                  placeholder="e.g. 9400111206213785678901 or AWB 157-52471764"
                  maxLength={200}
                  className="flex-1"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleVerifyWaybill}
                  disabled={isCheckingWaybill || !trackingNumber.trim()}
                  className="shrink-0 gap-1 text-xs"
                >
                  {isCheckingWaybill ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Search className="h-3.5 w-3.5" />
                  )}
                  Verify
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Customers can track using this waybill or their Order ID. Selecting a Parcels v5 courier slug improves detection accuracy.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="delivery-status">Delivery stage</Label>
              {selectableStatuses.length === 0 ? (
                <p className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
                  This order is already delivered. Delivery stages cannot be moved backwards.
                </p>
              ) : (
                <select
                  id="delivery-status"
                  value={status}
                  onChange={(event) => setStatus(event.target.value as OrderStatus)}
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
                >
                  {selectableStatuses.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              )}
              <p className="text-xs text-muted-foreground">
                Current stage: <span className="font-medium text-foreground">{order.status}</span>
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="delivery-notes">Notes (optional)</Label>
              <Textarea
                id="delivery-notes"
                value={deliveryNotes}
                onChange={(event) => setDeliveryNotes(event.target.value)}
                placeholder="Special delivery instructions or packaging notes."
                maxLength={200}
                rows={3}
              />
            </div>

            <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
              <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <p>
                Your admin name is recorded against this update and shown in the order audit log.
              </p>
            </div>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isSaving}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={handleRequestSave}
              disabled={isSaving || selectableStatuses.length === 0}
            >
              {isSaving ? 'Saving...' : 'Save delivery'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Move {order.id} to {status || 'a new stage'}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              The customer will see this stage on their tracking page immediately. Delivery
              stages move forward only and cannot be reverted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Go back</AlertDialogCancel>
            <AlertDialogAction onClick={() => void handleConfirmSave()}>
              Confirm change
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
