export default function ToggleSwitch({ checked, onChange }: { checked: boolean; onChange: () => void }) {
  return (
    <button
      onClick={onChange}
      className={`relative w-9 h-5 rounded-full transition-colors duration-200 ${
        checked ? 'bg-pi-accent' : 'bg-pi-border'
      }`}
    >
      <div
        className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform duration-200 ${
          checked ? 'translate-x-[18px]' : 'translate-x-0.5'
        }`}
      />
    </button>
  )
}
