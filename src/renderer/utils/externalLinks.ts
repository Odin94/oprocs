import { toast } from "sonner"

export const openExternalLink = (url: string) => {
    const open = window.oprocsAPI?.openExternalLink
    if (!open) {
        toast.error("Could not open link")
        return
    }

    void open(url).catch((error: unknown) => {
        toast.error("Could not open link", {
            description: error instanceof Error ? error.message : String(error),
        })
    })
}
